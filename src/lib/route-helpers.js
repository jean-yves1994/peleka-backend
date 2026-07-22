const { handleError } = require('./response');
function withHandler(fn) {
  return async (request, ctx) => {
    try { return await fn(request, ctx); }
    catch (err) { return handleError(err); }
  };
}
module.exports = { withHandler };
