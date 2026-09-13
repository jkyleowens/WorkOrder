// Integer-cent arithmetic for decimal strings returned by PostgreSQL.
const cents = (value) => {
  const text = String(value ?? 0);
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  const n = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  return negative ? -n : n;
};
const amount = (n) =>
  `${n < 0n ? "-" : ""}${(n < 0n ? -n : n) / 100n}.${String((n < 0n ? -n : n) % 100n).padStart(2, "0")}`;
module.exports = { cents, amount };
