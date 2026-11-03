const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');

// Updating one shared document first serializes relationship changes even across
// multiple API processes. MongoDB retries write conflicts with a fresh snapshot.
// The lock update, validation, and resource changes commit or roll back together.
const mutationSchema = new mongoose.Schema({
  _id: String,
  revision: { type: Number, default: 0 }
}, { versionKey: false });
const Mutation = mongoose.model('Mutation', mutationSchema);

async function initializeDatabase() {
  await Promise.all([User.init(), Task.init(), Mutation.init()]);
  await Mutation.updateOne({ _id: 'relationships' }, { $setOnInsert: { revision: 0 } }, { upsert: true });
}

async function mutate(operation) {
  return mongoose.connection.transaction(async session => {
    await Mutation.updateOne({ _id: 'relationships' }, { $inc: { revision: 1 } }, { session });
    return operation(session);
  }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
}

module.exports = { initializeDatabase, mutate };
