class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  let status = 500;
  let message = 'Unable to complete the request. Please try again later.';
  if (error instanceof ApiError) {
    status = error.status;
    message = error.message;
  } else if (error.type === 'entity.parse.failed') {
    status = 400;
    message = 'The request body must contain valid JSON.';
  } else if (error.type === 'entity.too.large') {
    status = 400;
    message = 'The request body is too large.';
  } else if (error.code === 11000) {
    status = 400;
    message = 'A user with that email already exists.';
  } else if (['ValidationError', 'CastError', 'StrictModeError'].includes(error.name)) {
    status = 400;
    message = 'One or more fields contain an invalid value.';
  }
  res.status(status).json({ message, data: null });
}

module.exports = { ApiError, errorHandler };
