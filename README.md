# tiny-stack-vm

One dependency-free `main.ts` interpreting make.fun's tiny stack ISA exactly: wrapping 32-bit arithmetic (Math.imul MUL, unsigned DIVU/MODU/LTU, counts masked to 5 bits), the 256-value stack, 64-deep calls, 256 memory words, and every trap with its own exit code, step and output limits included.

Run: `MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts`
