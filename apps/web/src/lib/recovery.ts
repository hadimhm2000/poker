import { createHash, randomInt } from "node:crypto";

// Letters and digits that cannot be misread (no 0/O, 1/I/L).
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const RECOVERY_CODE_COUNT = 10;

/** "K7M2P-9QWXT" style codes, 10 symbols (about 50 bits) each. */
export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: n }, () => {
    const s = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** Case, spaces and dashes do not matter when a code is typed back. */
export const normalizeRecoveryCode = (input: string) => input.toUpperCase().replace(/[^0-9A-Z]/g, "");

export const hashRecoveryCode = (input: string) =>
  createHash("sha256").update(`recovery:${normalizeRecoveryCode(input)}`).digest();

export const looksLikeTotp = (input: string) => /^\d{6}$/.test(input.replace(/\s/g, ""));

/** Cookie that carries freshly made codes to the page that shows them once. */
export const RECOVERY_FLASH = "recovery_flash";
