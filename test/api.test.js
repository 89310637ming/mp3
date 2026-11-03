const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const app = require('../app');
const User = require('../models/user');
const Task = require('../models/task');
const { initializeDatabase } = require('../lib/database');

let database, server, base;
const deadline = '2026-12-01T12:00:00.000Z';
const missing = '000000000000000000000001';
const userBody = (name = 'Ada') => ({ name, email: `${name.toLowerCase()}@example.com` });
const taskBody = (name = 'Write tests', extra = {}) => ({ name, deadline, ...extra });

async function request(method, path, body, query) {
  const url = new URL(base + path);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, JSON.stringify(value));
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (response.status === 204) {
    assert.equal(text, '');
    return { status: response.status };
  }
  const payload = JSON.parse(text);
  assert.deepEqual(Object.keys(payload).sort(), ['data', 'message']);
  assert.equal(typeof payload.message, 'string');
  assert.ok(payload.message.length > 0);
  return { status: response.status, ...payload };
}
async function createUser(name = 'Ada', extra = {}) {
  const response = await request('POST', '/users', { ...userBody(name), ...extra });
  assert.equal(response.status, 201, response.message);
  return response.data;
}
async function createTask(extra = {}, name) {
  const response = await request('POST', '/tasks', taskBody(name, extra));
  assert.equal(response.status, 201, response.message);
  return response.data;
}
async function getUser(id) { return (await request('GET', `/users/${id}`)).data; }
async function getTask(id) { return (await request('GET', `/tasks/${id}`)).data; }
async function snapshot() {
  return JSON.stringify({ users: await User.find().sort('_id').lean(), tasks: await Task.find().sort('_id').lean() });
}
async function consistent() {
  const users = await User.find().lean();
  const tasks = await Task.find().lean();
  for (const user of users) {
    assert.equal(new Set(user.pendingTasks).size, user.pendingTasks.length);
    for (const id of user.pendingTasks) {
      const task = tasks.find(candidate => candidate._id.toString() === id);
      assert.ok(task);
      assert.equal(task.completed, false);
      assert.equal(task.assignedUser, user._id.toString());
      assert.equal(task.assignedUserName, user.name);
    }
  }
  for (const task of tasks) {
    if (task.assignedUser) {
      const user = users.find(candidate => candidate._id.toString() === task.assignedUser);
      assert.ok(user);
      assert.equal(task.assignedUserName, user.name);
      assert.equal(user.pendingTasks.includes(task._id.toString()), !task.completed);
    } else {
      assert.equal(task.assignedUserName, 'unassigned');
      assert.ok(users.every(user => !user.pendingTasks.includes(task._id.toString())));
    }
  }
}

before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(database.getUri(), { dbName: 'mp3_tests' });
  await initializeDatabase();
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
beforeEach(async () => { await User.deleteMany({}); await Task.deleteMany({}); });
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (database) await database.stop();
});

test('creation defaults, server timestamps, and full PUT replacement', async () => {
  const user = await createUser('Ada', { dateCreated: '2000-01-01' });
  assert.deepEqual(user.pendingTasks, []);
  assert.ok(new Date(user.dateCreated).getFullYear() >= 2026);
  const task = await createTask({ description: 'Old description', completed: true, dateCreated: '2000-01-01' });
  assert.equal(task.assignedUser, '');
  assert.equal(task.assignedUserName, 'unassigned');
  let result = await request('PUT', `/tasks/${task._id}`, taskBody('Replacement', { dateCreated: '2000-01-01' }));
  assert.equal(result.status, 200);
  assert.equal(result.data.description, '');
  assert.equal(result.data.completed, false);
  assert.equal(result.data.dateCreated, task.dateCreated);
  result = await request('PUT', `/users/${user._id}`, { ...userBody('Ada Lovelace'), dateCreated: '2000-01-01' });
  assert.equal(result.status, 200);
  assert.equal(result.data.dateCreated, user.dateCreated);
  await consistent();
});

test('required fields and strict input types reject without writes', async () => {
  const invalidUsers = [{}, { name: 'Ada' }, { email: 'a@b.com' }, { name: ' ', email: 'a' },
    { name: 4, email: 'a' }, { name: 'Ada', email: null }, { ...userBody(), pendingTasks: null },
    { ...userBody(), pendingTasks: [3] }, { ...userBody(), pendingTasks: ['bad-id'] }];
  const invalidTasks = [{}, { name: 'A' }, { deadline }, taskBody('', {}), taskBody('A', { deadline: null }),
    taskBody('A', { deadline: [] }), taskBody('A', { deadline: true }), taskBody('A', { deadline: 'invalid' }),
    taskBody('A', { description: 2 }), taskBody('A', { completed: 'false' }),
    taskBody('A', { assignedUser: null }), taskBody('A', { assignedUser: 3 }),
    taskBody('A', { assignedUser: 'bad' }), taskBody('A', { assignedUserName: false })];
  for (const [path, inputs] of [['users', invalidUsers], ['tasks', invalidTasks]]) {
    for (const body of inputs) {
      const state = await snapshot();
      assert.equal((await request('POST', `/${path}`, body)).status, 400, JSON.stringify(body));
      assert.equal(await snapshot(), state);
    }
  }
});

test('duplicate email is rejected on create/update; keeping own email succeeds', async () => {
  const ada = await createUser();
  const grace = await createUser('Grace');
  assert.equal((await request('POST', '/users', userBody())).status, 400);
  const state = await snapshot();
  assert.equal((await request('PUT', `/users/${grace._id}`, { name: 'Grace', email: ada.email })).status, 400);
  assert.equal(await snapshot(), state);
  assert.equal((await request('PUT', `/users/${ada._id}`, userBody())).status, 200);
});

test('URL IDs take priority over invalid fields and missing references', async () => {
  for (const path of ['users', 'tasks']) {
    for (const id of ['malformed', missing]) {
      assert.equal((await request('GET', `/${path}/${id}`)).status, 404);
      assert.equal((await request('PUT', `/${path}/${id}`, {})).status, 404);
      assert.equal((await request('DELETE', `/${path}/${id}`)).status, 404);
    }
  }
});

test('missing references, completed pending tasks, and mismatch reject atomically', async () => {
  const ada = await createUser();
  const task = await createTask({ assignedUser: ada._id });
  const completed = await createTask({ completed: true });
  for (const [path, body, status] of [
    [`/users/${ada._id}`, { ...userBody(), pendingTasks: [task._id, missing] }, 404],
    [`/users/${ada._id}`, { ...userBody(), pendingTasks: [task._id, 'bad'] }, 400],
    [`/users/${ada._id}`, { ...userBody(), pendingTasks: [completed._id] }, 400],
    [`/tasks/${task._id}`, taskBody('A', { assignedUser: missing }), 404],
    [`/tasks/${task._id}`, taskBody('A', { assignedUser: ada._id, assignedUserName: 'Wrong' }), 400]
  ]) {
    const state = await snapshot();
    assert.equal((await request('PUT', path, body)).status, status);
    assert.equal(await snapshot(), state);
  }
  await consistent();
});

test('task assignment, reassignment, completion, reopening, and default unassignment', async () => {
  const ada = await createUser();
  const grace = await createUser('Grace');
  const task = await createTask({ assignedUser: ada._id });
  assert.deepEqual((await getUser(ada._id)).pendingTasks, [task._id]);
  for (const extra of [
    { assignedUser: grace._id, assignedUserName: grace.name },
    { assignedUser: grace._id, completed: true },
    { assignedUser: ada._id, completed: true },
    { assignedUser: ada._id, completed: false },
    { assignedUser: '' },
    { assignedUser: grace._id },
    {}
  ]) {
    assert.equal((await request('PUT', `/tasks/${task._id}`, taskBody('A', extra))).status, 200);
    await consistent();
  }
  assert.deepEqual((await getUser(ada._id)).pendingTasks, []);
  assert.deepEqual((await getUser(grace._id)).pendingTasks, []);
});

test('user pendingTasks moves tasks from other users and removes old assignments', async () => {
  const ada = await createUser();
  const grace = await createUser('Grace');
  const old = await createTask({ assignedUser: ada._id });
  const moved = await createTask({ assignedUser: grace._id });
  const unassigned = await createTask();
  const complete = await createTask({ assignedUser: ada._id, completed: true });
  const result = await request('PUT', `/users/${ada._id}`, {
    ...userBody('Renamed Ada'), pendingTasks: [moved._id, unassigned._id, moved._id]
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.pendingTasks, [moved._id, unassigned._id]);
  assert.equal((await getTask(old._id)).assignedUser, '');
  assert.equal((await getTask(complete._id)).assignedUserName, 'Renamed Ada');
  assert.equal((await getTask(complete._id)).completed, true);
  assert.deepEqual((await getUser(grace._id)).pendingTasks, []);
  await consistent();
  assert.equal((await request('PUT', `/users/${ada._id}`, userBody())).status, 200);
  assert.equal((await getTask(moved._id)).assignedUser, '');
  assert.equal((await getTask(complete._id)).assignedUser, ada._id);
  await consistent();
});

test('POST user with pendingTasks applies move rules; completed task POST stays assigned', async () => {
  const oldUser = await createUser();
  const task = await createTask({ assignedUser: oldUser._id });
  const newUser = await createUser('Grace', { pendingTasks: [task._id] });
  assert.equal((await getTask(task._id)).assignedUser, newUser._id);
  assert.deepEqual((await getUser(oldUser._id)).pendingTasks, []);
  const completed = await createTask({ completed: true, assignedUser: newUser._id });
  assert.equal(completed.assignedUserName, newUser.name);
  await consistent();
});

test('failed writes roll back changes even when the database fails after the main save', async () => {
  const user = await createUser();
  const task = await createTask({ assignedUser: user._id });
  const state = await snapshot();
  const original = User.updateMany;
  User.updateMany = () => { throw new Error('Simulated database failure with private details'); };
  try {
    const result = await request('PUT', `/tasks/${task._id}`, taskBody('Must roll back'));
    assert.equal(result.status, 500);
    assert.doesNotMatch(result.message, /Simulated|private|Mongo/i);
  } finally {
    User.updateMany = original;
  }
  assert.equal(await snapshot(), state);
  await consistent();
});

test('single-resource projection and ignored collection query parameters', async () => {
  const user = await createUser();
  const task = await createTask();
  for (const [path, doc] of [['users', user], ['tasks', task]]) {
    let response = await request('GET', `/${path}/${doc._id}`, undefined, { select: { name: 1, _id: 0 } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { name: doc.name });
    response = await request('GET', `/${path}/${doc._id}?where=invalid&sort=invalid&count=invalid&skip=invalid&limit=invalid`);
    assert.equal(response.status, 200);
    response = await request('GET', `/${path}/${doc._id}`, undefined, { select: { dateCreated: 0 } });
    assert.equal(response.data.dateCreated, undefined);
    assert.equal(response.data._id, doc._id);
    assert.equal((await request('GET', `/${path}/${doc._id}?select=invalid`)).status, 400);
  }
});

test('combined filtering, sorting, projection, pagination, count, and no matches', async () => {
  const a = await createTask({}, 'A');
  const b = await createTask({ completed: true }, 'B');
  const c = await createTask({}, 'C');
  const response = await request('GET', '/tasks', undefined, {
    where: { _id: { $in: [a._id, b._id, c._id] }, completed: false },
    sort: { name: -1 }, select: { name: 1, _id: 0 }, skip: 1, limit: 1
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, [{ name: 'A' }]);
  assert.equal((await request('GET', '/tasks', undefined, {
    where: { completed: false }, count: true, skip: 99, limit: 1
  })).data, 2);
  for (const path of ['users', 'tasks']) {
    assert.deepEqual((await request('GET', `/${path}`, undefined, { where: { _id: missing } })).data, []);
    assert.equal((await request('GET', `/${path}`, undefined, { where: { _id: missing }, count: true })).data, 0);
  }
});

test('default task limit is 100; users and limit=0 are unlimited', async () => {
  await Task.insertMany(Array.from({ length: 105 }, (_, index) => taskBody(`Task ${index}`)));
  await User.insertMany(Array.from({ length: 105 }, (_, index) => userBody(`User ${index}`)));
  assert.equal((await request('GET', '/tasks')).data.length, 100);
  assert.equal((await request('GET', '/tasks', undefined, { limit: 0 })).data.length, 105);
  assert.equal((await request('GET', '/tasks', undefined, { count: true })).data, 105);
  assert.equal((await request('GET', '/users')).data.length, 105);
});

test('malformed JSON and wrong query types return readable 400 responses', async () => {
  for (const key of ['where', 'sort', 'select', 'skip', 'limit', 'count']) {
    assert.equal((await request('GET', `/tasks?${key}=invalid`)).status, 400, key);
  }
  for (const query of [
    { where: [] }, { where: null }, { sort: { name: 0 } }, { sort: [] },
    { select: { name: 1, deadline: 0 } }, { select: { name: '1' } },
    { skip: -1 }, { limit: 1.2 }, { count: 1 }, { limit: null },
    { where: { $where: 'return true' } }, { where: { _id: 'bad' } },
    { where: { $nonsense: 1 } }
  ]) {
    const result = await request('GET', '/tasks', undefined, query);
    assert.equal(result.status, 400, JSON.stringify(query));
    assert.doesNotMatch(result.message, /CastError|MongoServerError|mongoose/i);
  }
  assert.equal((await request('GET', '/tasks?limit=1&limit=2')).status, 400);
  const malformed = await fetch(base + '/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{'
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(Object.keys(await malformed.json()).sort(), ['data', 'message']);
});

test('deleting tasks cleans references; deleting users unassigns completed tasks too', async () => {
  const ada = await createUser();
  const task = await createTask({ assignedUser: ada._id });
  assert.equal((await request('DELETE', `/tasks/${task._id}`)).status, 204);
  assert.deepEqual((await getUser(ada._id)).pendingTasks, []);
  assert.equal((await request('GET', `/tasks/${task._id}`)).status, 404);
  const pending = await createTask({ assignedUser: ada._id });
  const complete = await createTask({ assignedUser: ada._id, completed: true });
  assert.equal((await request('DELETE', `/users/${ada._id}`)).status, 204);
  assert.equal((await request('GET', `/users/${ada._id}`)).status, 404);
  for (const id of [pending._id, complete._id]) assert.equal((await getTask(id)).assignedUser, '');
  await consistent();
});

test('simultaneous task moves and user rename preserve both directions', async () => {
  const ada = await createUser();
  const grace = await createUser('Grace');
  const task = await createTask({ assignedUser: ada._id });
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    request('PUT', `/tasks/${task._id}`, taskBody(`Move ${index}`, {
      assignedUser: index % 2 ? grace._id : ada._id, completed: index % 3 === 0
    }))));
  assert.ok(results.every(result => result.status === 200));
  const more = await Promise.all([
    request('PUT', `/users/${ada._id}`, { ...userBody('Renamed'), pendingTasks: [task._id] }),
    request('PUT', `/tasks/${task._id}`, taskBody('Concurrent', { assignedUser: ada._id }))
  ]);
  // The user PUT may reject a completed task if it observes that prior state.
  assert.ok(more.every(result => [200, 400].includes(result.status)));
  await consistent();
});

test('CORS preflight, API index, and unknown routes have appropriate responses', async () => {
  const response = await fetch(base + '/users', { method: 'OPTIONS' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-methods'), /PUT/);
  assert.equal((await request('GET', '/')).status, 200);
  assert.equal((await request('GET', '/missing')).status, 404);
});


test('invalid PUT bodies and missing POST references make no changes', async () => {
  const user = await createUser();
  const task = await createTask({ assignedUser: user._id });
  for (const [method, path, body, status] of [
    ['PUT', `/users/${user._id}`, { name: 'Missing email' }, 400],
    ['PUT', `/tasks/${task._id}`, { name: 'Missing deadline' }, 400],
    ['POST', '/users', { ...userBody('Grace'), pendingTasks: [missing] }, 404],
    ['POST', '/tasks', taskBody('Missing user', { assignedUser: missing }), 404],
    ['POST', '/tasks', taskBody('Invalid first', { assignedUser: missing, completed: 'true' }), 400]
  ]) {
    const state = await snapshot();
    assert.equal((await request(method, path, body)).status, status);
    assert.equal(await snapshot(), state);
  }
});

test('a concurrent user deletion and completed task creation cannot orphan an assignment', async () => {
  const user = await createUser();
  const results = await Promise.all([
    request('DELETE', `/users/${user._id}`),
    request('POST', '/tasks', taskBody('Completed', { assignedUser: user._id, completed: true }))
  ]);
  assert.equal(results[0].status, 204);
  assert.ok([201, 404].includes(results[1].status));
  await consistent();
});
