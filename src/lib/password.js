const bcrypt = require('bcrypt');
const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
async function hashPassword(plain) { return bcrypt.hash(plain, ROUNDS); }
async function verifyPassword(plain, hash) { if (!plain || !hash) return false; return bcrypt.compare(plain, hash); }
function isPasswordStrong(pwd) {
  if (typeof pwd !== 'string' || pwd.length < 8) return false;
  if (!/[A-Za-z]/.test(pwd)) return false;
  if (!/[0-9]/.test(pwd)) return false;
  return true;
}
module.exports = { hashPassword, verifyPassword, isPasswordStrong };
