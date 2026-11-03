const { ApiError } = require('./errors');
const { isObject } = require('./validation');
const bad = message => { throw new ApiError(400, message); };

function parse(query, name, fallback) {
  if (query[name] === undefined) return fallback;
  if (typeof query[name] !== 'string') bad(`${name} must be supplied once as JSON.`);
  try { return JSON.parse(query[name]); }
  catch { bad(`${name} must contain valid JSON.`); }
}

function objectParameter(query, name) {
  const value = parse(query, name, {});
  if (!isObject(value)) bad(`${name} must be a JSON object.`);
  return value;
}

function projection(query) {
  const select = objectParameter(query, 'select');
  let mode;
  for (const [field, value] of Object.entries(select)) {
    if (!field || field.startsWith('$') || ![0, 1].includes(value)) {
      bad('select must map field names to 1 (include) or 0 (exclude).');
    }
    if (field !== '_id') {
      if (mode !== undefined && mode !== value) bad('select cannot mix included and excluded fields, except for _id.');
      mode = value;
    }
  }
  return select;
}

function rejectExecutableOperators(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['$where', '$function', '$accumulator', '__proto__', 'constructor', 'prototype'].includes(key)) {
      bad('where contains an unsupported query operator.');
    }
    rejectExecutableOperators(child);
  }
}

function listOptions(query, defaultLimit) {
  const where = objectParameter(query, 'where');
  rejectExecutableOperators(where);
  const sort = objectParameter(query, 'sort');
  for (const [field, direction] of Object.entries(sort)) {
    if (!field || field.startsWith('$') || ![1, -1].includes(direction)) {
      bad('sort must map field names to 1 (ascending) or -1 (descending).');
    }
  }
  const select = projection(query);
  const skip = parse(query, 'skip', 0);
  const limit = parse(query, 'limit', defaultLimit);
  for (const [name, value] of [['skip', skip], ['limit', limit]]) {
    if (!Number.isSafeInteger(value) || value < 0) bad(`${name} must be a nonnegative integer.`);
  }
  const count = parse(query, 'count', false);
  if (typeof count !== 'boolean') bad('count must be true or false.');
  return { where, sort, select, skip, limit, count };
}

async function runList(Model, query, defaultLimit) {
  const options = listOptions(query, defaultLimit);
  try {
    // count reports all matches, independent of pagination or projection.
    if (options.count) return await Model.countDocuments(options.where).maxTimeMS(10000);
    return await Model.find(options.where).sort(options.sort).select(options.select)
      .skip(options.skip).limit(options.limit).maxTimeMS(10000).lean();
  } catch (error) {
    if (error.name === 'CastError' ||
        (error.name === 'MongoServerError' && [2, 9, 14, 168, 15959, 31253, 31254].includes(error.code)) ||
        (error.name === 'Error' && /operator|query|projection/i.test(error.message))) {
      bad('The query contains an invalid field value or operator.');
    }
    throw error;
  }
}

module.exports = { projection, listOptions, runList };
