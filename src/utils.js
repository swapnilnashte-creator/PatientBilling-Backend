export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('Invalid amount'), { status: 400 });
  return n.toFixed(2);
}

export function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function notFound(message = 'Not found') {
  return Object.assign(new Error(message), { status: 404 });
}

export function forbidden(message = 'Forbidden') {
  return Object.assign(new Error(message), { status: 403 });
}
