const { ApiError } = require('./errors');
const validId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bad = message => { throw new ApiError(400, message); };

function requiredString(body, field) {
  if (typeof body[field] !== 'string' || !body[field].trim()) {
    bad(`${field} is required and must be a nonempty string.`);
  }
  return body[field].trim();
}

function validateBody(body) {
  if (!isObject(body)) bad('The request body must be an object.');
}

function userInput(body) {
  validateBody(body);
  const name = requiredString(body, 'name');
  const email = requiredString(body, 'email');
  const pendingTasks = has(body, 'pendingTasks') ? body.pendingTasks : [];
  if (!Array.isArray(pendingTasks) || !pendingTasks.every(validId)) {
    bad('pendingTasks must be an array of valid task IDs.');
  }
  return { name, email, pendingTasks: [...new Set(pendingTasks.map(id => id.toLowerCase()))] };
}

function taskInput(body) {
  validateBody(body);
  const name = requiredString(body, 'name');
  // Do not let Mongoose silently coerce arrays, booleans, or null to dates.
  if (!has(body, 'deadline') ||
      !['string', 'number'].includes(typeof body.deadline) ||
      (typeof body.deadline === 'string' && !body.deadline.trim())) {
    bad('deadline is required and must be a valid date.');
  }
  const deadline = new Date(body.deadline);
  if (Number.isNaN(deadline.getTime())) bad('deadline must be a valid date.');
  if (has(body, 'description') && typeof body.description !== 'string') bad('description must be a string.');
  if (has(body, 'completed') && typeof body.completed !== 'boolean') bad('completed must be a boolean.');
  if (has(body, 'assignedUser') && body.assignedUser !== '' && !validId(body.assignedUser)) {
    bad('assignedUser must be a valid user ID or an empty string.');
  }
  if (has(body, 'assignedUserName') && typeof body.assignedUserName !== 'string') {
    bad('assignedUserName must be a string.');
  }
  const assignedUser = (body.assignedUser || '').toLowerCase();
  return {
    name, deadline,
    description: has(body, 'description') ? body.description : '',
    completed: has(body, 'completed') ? body.completed : false,
    assignedUser,
    assignedUserName: has(body, 'assignedUserName') ? body.assignedUserName : undefined
  };
}

module.exports = { validId, isObject, has, userInput, taskInput };
