// A tiny stack VM: a plain, exact interpreter for make.fun's tiny stack ISA; every trap keeps
// its own exit code. Node built-ins only, deterministic.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Stack tables: [opcode, pops, pushes]; PP is -1 for no opcode.
const PP = new Int8Array(256).fill(-1);
const PU = new Int8Array(256);
const T = [
  [0, 0, 0], [1, 0, 1], [2, 0, 1], [3, 1, 0], [4, 1, 2], [5, 2, 2], [6, 2, 3], [7, 3, 3],
  [48, 0, 0], [49, 1, 0], [50, 1, 0], [51, 0, 0], [52, 0, 0], [64, 1, 1], [65, 2, 0],
  [80, 1, 0], [81, 1, 0], [82, 0, 1], [83, 1, 0],
];
for (const [o, p, u] of T) {
  PP[o] = p;
  PU[o] = u;
}
for (let o = 0x10; o <= 0x22; o++) { // the operators pop 2, push 1
  PP[o] = 2;
  PU[o] = 1;
}
PP[0x17] = 1; // NEG pops 1
PP[0x1b] = 1; // NOT pops 1
PP[0x1f] = -1; // 0x1f names no opcode
/** Runs one program: the bytes it wrote and the code it ended with (a trap's code for a trap). */
function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; code: number } {
  const n = p.length;
  const D = new Int32Array(256); // data stack
  const C = new Int32Array(64); // call stack
  const M = new Int32Array(256); // memory words, zeroed
  const out = new Uint8Array(65536);
  let sp = 0;
  let csp = 0;
  let ol = 0;
  let ip = 0;
  let pc = 0;
  let st = 0;
  const done = (code: number) => ({ out: out.slice(0, ol), code });

  for (;;) {
    // One step, in the ISA's order; stack needs are checked before the instruction's own traps.
    if (st === 1000000) return done(10);
    if (pc < 0 || pc >= n) return done(9);
    const op = p[pc];
    const pops = PP[op];
    if (pops < 0) return done(5);
    const imm = op === 1 ? 1 : op === 2 ? 4 : op >= 0x30 && op <= 0x33 ? 2 : 0; // immediate bytes
    if (pc + imm >= n) return done(9);
    st++;
    if (sp < pops) return done(2);
    if (sp - pops + PU[op] > 256) return done(3);
    const nx = pc + 1 + imm; // the next instruction's address
    pc = nx;
    switch (op) {
      case 0x00: // HALT
        return done(0);
      case 0x01: // PUSH8: sign-extended
        D[sp++] = (p[nx - 1] << 24) >> 24;
        break;
      case 0x02: // PUSH32: little-endian, signed
        D[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24);
        break;
      case 0x03: // POP
        sp--;
        break;
      case 0x04: // DUP
        D[sp] = D[sp - 1];
        sp++;
        break;
      case 0x05: { // SWAP
        const t = D[sp - 1];
        D[sp - 1] = D[sp - 2];
        D[sp - 2] = t;
        break;
      }
      case 0x06: // OVER
        D[sp] = D[sp - 2];
        sp++;
        break;
      case 0x07: { // ROT: ( a b c -- b c a )
        const a = D[sp - 3];
        D[sp - 3] = D[sp - 2];
        D[sp - 2] = D[sp - 1];
        D[sp - 1] = a;
        break;
      }
      case 0x17: // NEG: wraps
        D[sp - 1] = -D[sp - 1] | 0;
        break;
      case 0x1b: // NOT
        D[sp - 1] = ~D[sp - 1];
        break;
      case 0x30: // JMP, JZ, JNZ: pc = next + signed offset when taken; target checked next step
      case 0x31:
      case 0x32: {
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        let take = op === 0x30;
        if (!take) {
          const v = D[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = nx + rel;
        break;
      }
      case 0x33: // CALL: the immediate is the unsigned target
        if (csp === 64) return done(7);
        C[csp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (csp === 0) return done(8);
        pc = C[--csp];
        break;
      case 0x40: { // LOAD
        const a = D[sp - 1];
        if (a < 0 || a > 255) return done(6);
        D[sp - 1] = M[a];
        break;
      }
      case 0x41: { // STORE: ( v addr -- )
        const a = D[sp - 1];
        if (a < 0 || a > 255) return done(6);
        M[a] = D[sp - 2];
        sp -= 2;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII, no padding or newline
        const s = String(D[sp - 1]);
        if (ol + s.length > 65536) return done(11); // past the limit: writes nothing
        for (let i = 0; i < s.length; i++) out[ol++] = s.charCodeAt(i);
        sp--;
        break;
      }
      case 0x51: // PUTC: the value's low byte
        if (ol === 65536) return done(11);
        out[ol++] = D[--sp] & 255;
        break;
      case 0x52: // IN: next input byte, -1 once used up
        D[sp++] = ip < inp.length ? inp[ip++] : -1;
        break;
      case 0x53: // EXIT: code is the low byte
        return done(D[--sp] & 255);
      default: { // the binary operators: ( a b -- r ), b on top
        const b = D[sp - 1];
        const a = D[sp - 2];
        let r: number;
        switch (op) {
          case 0x10: r = (a + b) | 0; break; // ADD
          case 0x11: r = (a - b) | 0; break; // SUB
          case 0x12: r = Math.imul(a, b); break; // MUL: low 32 bits of the exact product
          case 0x13: // DIV: signed, toward zero
            if (b === 0) return done(4);
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
            break;
          case 0x14: // MOD: sign of a
            if (b === 0) return done(4);
            r = b === -1 ? 0 : a % b;
            break;
          case 0x15: // DIVU: unsigned
            if (b === 0) return done(4);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16: // MODU: unsigned
            if (b === 0) return done(4);
            r = (a >>> 0) % (b >>> 0) | 0;
            break;
          case 0x18: r = a & b; break; // AND
          case 0x19: r = a | b; break; // OR
          case 0x1a: r = a ^ b; break; // XOR
          case 0x1c: r = a << (b & 31); break; // SHL: count is b & 31
          case 0x1d: r = a >> (b & 31); break; // SHR: arithmetic
          case 0x1e: r = (a >>> (b & 31)) | 0; break; // SHRU: logical
          case 0x20: r = a === b ? 1 : 0; break; // EQ
          case 0x21: r = a < b ? 1 : 0; break; // LT: signed
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break; // 0x22 LTU: unsigned
        }
        D[sp - 2] = r;
        sp--;
        break;
      }
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(
    new Uint8Array(readFileSync(join(I, id, 'program.bin'))),
    new Uint8Array(readFileSync(join(I, id, 'input.bin'))),
  );
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), r.code + '\n');
}


