function validate(data) {
  if (
    !data ||
    data.version !== 1 ||
    !["projects", "inventory", "employees", "sessions", "activity"].every((k) =>
      Array.isArray(data[k]),
    )
  )
    throw new Error("Invalid workspace format");
  if (JSON.stringify(data).length > 5_000_000)
    throw new Error("Workspace exceeds 5 MB");
  for (const item of data.inventory)
    if (
      !Number.isFinite(item.quantity) ||
      item.quantity < 0 ||
      !Number.isFinite(item.minimum) ||
      item.minimum < 0
    )
      throw new Error("Invalid stock quantity");
}
module.exports = { validate };
