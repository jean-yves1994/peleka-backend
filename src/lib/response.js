const { NextResponse } = require('next/server');
const { AppError } = require('./errors');
const { ZodError } = require('zod');

const ok        = (data, init = {}) => NextResponse.json({ success: true, data }, { status: 200, ...init });
const created   = (data) => NextResponse.json({ success: true, data }, { status: 201 });
const noContent = () => new NextResponse(null, { status: 204 });
const paginated = (items, { page, pageSize, total }) =>
  NextResponse.json({ success: true, data: items, meta: {
    page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } });
const fail = (status, code, message, details) =>
  NextResponse.json({ success: false, error: { code, message, details } }, { status });

function handleError(err) {
  if (err instanceof ZodError) return fail(422, 'VALIDATION_ERROR', 'Validation failed', err.flatten());
  if (err instanceof AppError) return fail(err.status, err.code, err.message, err.details);
  if (err && err.code === '23505') return fail(409, 'CONFLICT', 'A record with the same unique field already exists.');
  if (err && err.code === '23503') return fail(409, 'FK_VIOLATION', 'Referenced record does not exist.');
  console.error('[unhandled]', err);
  const isProd = process.env.NODE_ENV === 'production';
  return fail(500, 'INTERNAL_ERROR', isProd ? 'Internal server error' : (err?.message || 'Unknown error'));
}

module.exports = { ok, created, noContent, paginated, fail, handleError };
