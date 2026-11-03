const User = require('../models/user');
const Task = require('../models/task');
const { ApiError } = require('./errors');
const { validId, userInput, taskInput } = require('./validation');
const { mutate } = require('./database');

async function findResource(Model, id, session) {
  const label = Model === User ? 'User' : 'Task';
  if (!validId(id)) throw new ApiError(404, `${label} not found.`);
  const query = Model.findById(id);
  if (session) query.session(session);
  const resource = await query;
  if (!resource) throw new ApiError(404, `${label} not found.`);
  return resource;
}

async function writeUser(body, id) {
  return mutate(async session => {
    // The URL resource takes priority over validation errors in the body.
    const previous = id === undefined ? null : await findResource(User, id, session);
    const input = userInput(body);
    const duplicate = await User.exists({ email: input.email,
      ...(previous ? { _id: { $ne: previous._id } } : {}) }).session(session);
    if (duplicate) throw new ApiError(400, 'A user with that email already exists.');
    const tasks = await Task.find({ _id: { $in: input.pendingTasks } }).session(session);
    if (tasks.some(task => task.completed)) throw new ApiError(400, 'pendingTasks cannot contain completed tasks.');
    if (tasks.length !== input.pendingTasks.length) throw new ApiError(404, 'One or more pending tasks do not exist.');

    const user = previous || new User();
    const userId = user._id.toString();
    const removed = previous ? previous.pendingTasks.filter(taskId => !input.pendingTasks.includes(taskId)) : [];
    user.set(input);
    await user.save({ session });
    if (removed.length) {
      await Task.updateMany({ _id: { $in: removed }, assignedUser: userId },
        { $set: { assignedUser: '', assignedUserName: 'unassigned' } }, { session });
    }
    if (input.pendingTasks.length) {
      // Pull from all previous owners before assigning the selected tasks.
      await User.updateMany({ _id: { $ne: user._id }, pendingTasks: { $in: input.pendingTasks } },
        { $pull: { pendingTasks: { $in: input.pendingTasks } } }, { session });
      await Task.updateMany({ _id: { $in: input.pendingTasks } },
        { $set: { assignedUser: userId, assignedUserName: input.name } }, { session });
    }
    // A rename also updates completed tasks, which are absent from pendingTasks.
    await Task.updateMany({ assignedUser: userId }, { $set: { assignedUserName: input.name } }, { session });
    return user.toObject();
  });
}

async function writeTask(body, id) {
  return mutate(async session => {
    const previous = id === undefined ? null : await findResource(Task, id, session);
    const input = taskInput(body);
    if (input.assignedUser) {
      const user = await User.findById(input.assignedUser).session(session);
      if (!user) throw new ApiError(404, 'The assigned user does not exist.');
      if (input.assignedUserName !== undefined && input.assignedUserName !== user.name) {
        throw new ApiError(400, 'assignedUserName must match the assigned user’s name.');
      }
      input.assignedUserName = user.name;
    } else {
      input.assignedUserName = 'unassigned';
    }
    const task = previous || new Task();
    task.set(input);
    await task.save({ session });
    const taskId = task._id.toString();
    await User.updateMany({ pendingTasks: taskId }, { $pull: { pendingTasks: taskId } }, { session });
    if (input.assignedUser && !input.completed) {
      await User.updateOne({ _id: input.assignedUser }, { $addToSet: { pendingTasks: taskId } }, { session });
    }
    return task.toObject();
  });
}

async function deleteUser(id) {
  return mutate(async session => {
    const user = await findResource(User, id, session);
    await Task.updateMany({ assignedUser: user._id.toString() },
      { $set: { assignedUser: '', assignedUserName: 'unassigned' } }, { session });
    await User.deleteOne({ _id: user._id }, { session });
  });
}

async function deleteTask(id) {
  return mutate(async session => {
    const task = await findResource(Task, id, session);
    await User.updateMany({ pendingTasks: task._id.toString() },
      { $pull: { pendingTasks: task._id.toString() } }, { session });
    await Task.deleteOne({ _id: task._id }, { session });
  });
}

module.exports = { findResource, writeUser, writeTask, deleteUser, deleteTask };
