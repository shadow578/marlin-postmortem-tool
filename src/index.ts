// Usage: node postmortem_analyzer.js [<addr2line_path>] [<firmware.elf>] <fault.txt>
// or: node postmortem_analyzer.js [<addr2line_path>] [<firmware.elf>] (will prompt for fault input)
//
// - <addr2line_path> - path to the addr2line executable. defaults to 'arm-none-eabi-addr2line'
// - <firmware.elf> - path to the firmware elf file. defaults to './firmware.elf'
// - <fault.txt> - path to the fault log file to analyze. if not provided, will prompt for input
//
// ALL PARAMETERS ARE POSITIONAL

import * as fs from 'fs/promises';
import * as fssync from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as readline from 'readline';
import * as CFRS from './cfsr';

const execAsync = promisify(exec);

let addr2linePath: string;
let elfPath: string;

interface Addr2LineResult {
  filePath: string;
  fileName: string;
  line: number;
  function: string;
}

interface BacktraceInfo {
  position: number;
  name: string;
  fnAddress: number;
  fnOffset: number;
  pc: number;
}

async function addr2Line(address: number): Promise<Addr2LineResult | undefined> {
  // addr2line -e <elf> -f -C <address>
  // -e <elf> - the elf file to use
  // -f - show function name
  // -C - demangle function name
  // <address> - the address to lookup
  const cmd = `${addr2linePath} -e ${elfPath} -f -C ${address.toString(16)}`;
  const output = await execAsync(cmd);

  // parse output
  //> GcodeSuite::process_parsed_command(bool)
  //> E:\Source\marlin\Marlin-H32/Marlin\src\gcode/gcode.cpp:339
  const lines = output.stdout.split(/\r?\n/);
  const fn = lines[0];
  const fileLine = lines[1];

  const pattern = /(.+):(\d+)/;
  const match = pattern.exec(fileLine);
  if (!match) {
    return;
    //throw new Error(`Failed to parse addr2line output: ${output.stdout}`);
  }
  const filePath = match[1];
  const line = match[2];

  const fileName = path.basename(filePath);

  return {
    filePath,
    fileName: fileName || filePath,
    line: parseInt(line, 10),
    function: fn,
  };
}

async function parseBacktraceLine(line: string): Promise<(Addr2LineResult & BacktraceInfo) | undefined> {
  // check if the line contains a backtrace entry
  // #1<position> : <name>@<address>+<offset> PC:<address>
  // #1 : unknown@0x0001C38C+182 PC:0x0001C442
  const pattern = /#(\d+) : ([^@]+)@0x([0-9A-Fa-f]+)\+(\d+) PC:0x([0-9A-Fa-f]+)/;
  const match = pattern.exec(line);
  if (!match) {
    return;
  }

  //const matchStr = match[0];
  const position = parseInt(match[1], 10); // DEC
  const name = match[2];
  const fnAddress = parseInt(match[3], 16); // HEX
  const fnOffset = parseInt(match[4], 10); // DEC
  const pc = parseInt(match[5], 16); // HEX

  // call addr2line
  const a2l = await addr2Line(pc);
  if (!a2l) {
    console.error(`Failed to lookup address: ${pc.toString(16)}`);
    return;
  }

  // lookup pc address in elf file
  return {
    ...a2l,
    position,
    name,
    fnAddress,
    fnOffset,
    pc,
  };
}

type RegisterInfo = {
  register: string;
  value: number;
};

function parseRegisterLine(line: string): RegisterInfo | undefined {
  // parse register dump line
  // R0   : 0x00000001
  // CFSR : 0x00000000
  const pattern = /^([A-Za-z0-9]+)\s*:\s+0x([0-9A-Fa-f]+)$/;
  const match = pattern.exec(line);
  if (!match) {
    return;
  }

  const register = match[1];
  const value = parseInt(match[2], 16);

  return {
    register,
    value,
  };
}

async function printRegisters(registers: RegisterInfo[]) {
  const findRegister = (reg: string) => registers.find((r) => r.register.toUpperCase() === reg.toUpperCase());

  // [line][column]
  const out: string[][] = [['Register', 'Value']];

  // find LR and PC registers
  const lr = findRegister('LR');
  const pc = findRegister('PC');

  // print LR and PC, add addr2line info to both
  if (lr) {
    const a2l = await addr2Line(lr.value);
    if (!a2l) {
      console.error(`Failed to lookup LR: ${lr.value.toString(16)}`);
    } else {
      out.push(['LR', numToHex(lr.value), a2l.function, `${a2l.fileName}:${a2l.line}`]);
    }
  }

  if (pc) {
    const a2l = await addr2Line(pc.value);
    if (!a2l) {
      console.error(`Failed to lookup PC: ${pc.value.toString(16)}`);
    } else {
      out.push(['PC', numToHex(pc.value), a2l.function, `${a2l.fileName}:${a2l.line}`]);
    }
  }

  // get MMAR and BFAR registers
  const mmar = findRegister('MMAR');
  const bfar = findRegister('BFAR');

  // print CFSR register
  const cfsrReg = findRegister('CFSR');
  if (cfsrReg) {
    const cfsr = cfsrReg.value;

    const checkFlag = (flag: number, name: string, extraColumnsIfSet: string[] = []) => {
      if (cfsr & flag) {
        out.push(['', name, ...extraColumnsIfSet]); // empty column for alignment
      }
    };

    // Memory Management Fault
    if (cfsr & CFRS.MEMFAULTSR_MASK) {
      out.push(['', 'Memory Management Fault']);
      checkFlag(CFRS.MMARVALID_MASK, 'MMARVALID', mmar ? [`MMAR: ${numToHex(mmar.value)}`] : []);
      checkFlag(CFRS.MLSPERR_MASK, 'MLSPERR');
      checkFlag(CFRS.MSTKERR_MASK, 'MSTKERR');
      checkFlag(CFRS.MUNSTKERR_MASK, 'MUNSTKERR');
      checkFlag(CFRS.DACCVIOL_MASK, 'DACCVIOL');
      checkFlag(CFRS.IACCVIOL_MASK, 'IACCVIOL');
    }

    // But Fault
    if (cfsr & CFRS.BUSFAULTSR_MASK) {
      out.push(['', 'Bus Fault']);
      checkFlag(CFRS.BFARVALID_MASK, 'BFARVALID', bfar ? [`BFAR: ${numToHex(bfar.value)}`] : []);
      checkFlag(CFRS.LSPERR_MASK, 'LSPERR');
      checkFlag(CFRS.STKERR_MASK, 'STKERR');
      checkFlag(CFRS.UNSTKERR_MASK, 'UNSTKERR');
      checkFlag(CFRS.IMPRECISERR_MASK, 'IMPRECISERR');
      checkFlag(CFRS.PRECISERR_MASK, 'PRECISERR');
      checkFlag(CFRS.IBUSERR_MASK, 'IBUSERR');
    }

    // Usage Fault
    if (cfsr & CFRS.USAGEFAULTSR_MASK) {
      out.push(['', 'Usage Fault']);
      checkFlag(CFRS.DIVBYZERO_MASK, 'DIVBYZERO');
      checkFlag(CFRS.UNALIGNED_MASK, 'UNALIGNED');
      checkFlag(CFRS.NOCP_MASK, 'NOCP');
      checkFlag(CFRS.INVPC_MASK, 'INVPC');
      checkFlag(CFRS.INVSTATE_MASK, 'INVSTATE');
      checkFlag(CFRS.UNDEFINSTR_MASK, 'UNDEFINSTR');
    }
  }

  // print output
  printAsTable(out);
}

function numToHex(num: number): string {
  return '0x' + num.toString(16).padStart(8, '0');
}

function readMultilineInput(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const inputLines: string[] = [];

  return new Promise<string>((resolve) => {
    const readLine = () => {
      rl.question('', (line) => {
        if (line === '') {
          rl.close();
          resolve(inputLines.join('\n'));
        } else {
          inputLines.push(line);
          readLine();
        }
      });
    };

    readLine();
  });
}

function printAsTable(lines: string[][]) {
  // output lines as table, column width is determined by the longest entry in each column
  const columnWidths: number[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const len = line[i].length;
      if (columnWidths[i] == undefined || len > columnWidths[i]) {
        columnWidths[i] = len;
      }
    }
  }

  // format and output lines
  for (const line of lines) {
    let str = '';
    for (let i = 0; i < line.length; i++) {
      const len = columnWidths[i];
      const entry = line[i];
      str += entry.padEnd(len + 2, ' ');
    }
    console.log(str);
  }
}

async function main() {
  // read args
  const args = process.argv.slice(2);
  addr2linePath = args[0] || 'arm-none-eabi-addr2line';
  elfPath = args[1] || './firmware.elf';
  const faultPath = args[2];

  // check elf file exists
  if (!fssync.existsSync(elfPath)) {
    throw new Error(`Elf file not found: ${elfPath}`);
  }

  // read fault from user input or file
  let faultText: string;
  if (faultPath && fssync.existsSync(faultPath)) {
    // read backtrace from file
    faultText = await fs.readFile(faultPath, 'utf-8');
  } else {
    // get backtrace from user input
    console.log('Enter Fault Log:');
    faultText = await readMultilineInput();
  }

  // split file into lines
  let lines = faultText.split('\n');

  // strip lines starting with 'Recv: ', irgnoring case (OctoPrint terminal)
  lines = lines.map((line) => line.replace(/^recv: /i, ''));

  // parse register dump
  const registers: RegisterInfo[] = [];
  for (const line of lines) {
    const register = parseRegisterLine(line);
    if (register) {
      registers.push(register);
    }
  }
  await printRegisters(registers);

  // parse lines of the backtrace
  const btLines: string[][] = [[], ["Backtrace"], ['#', 'Function', 'Address', 'PC', 'File:Line']];
  for (const line of lines) {
    const bt = await parseBacktraceLine(line);
    if (bt) {
      btLines.push([
        `#${bt.position}`,
        `${bt.function}${bt.name == 'unknown' ? '' : ` (${bt.name})`}`,
        `@ ${numToHex(bt.fnAddress)} + ${bt.fnOffset}`,
        `PC:${numToHex(bt.pc)}`,
        `${bt.fileName}:${bt.line}`,
      ]);
    }
  }

  printAsTable(btLines);
}

main()
  .then(() => {
    console.log('done');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
