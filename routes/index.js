const express = require('express');
const User = require('../models/user');
const Task = require('../models/task');
const { writeUser, writeTask, deleteUser, deleteTask } = require('../lib/resources');
const { runList, projection } = require('../lib/query');
const { validId } = require('../lib/validation');
const { ApiError } = require('../lib/errors');

module.exports = function (app) {
  const router = express.Router();
  require('./home')(router);
  for (const [path, Model, write, remove, limit] of [
    ['users', User, writeUser, deleteUser, 0],
    ['tasks', Task, writeTask, deleteTask, 100]
  ]) {
    router.get(`/${path}`, async (req, res) => {
      res.json({ message: 'OK', data: await runList(Model, req.query, limit) });
    });
    router.post(`/${path}`, async (req, res) => {
      res.status(201).json({ message: 'Created', data: await write(req.body) });
    });
    router.get(`/${path}/:id`, async (req, res) => {
      if (!validId(req.params.id)) throw new ApiError(404, `${Model.modelName} not found.`);
      const data = await Model.findById(req.params.id).select(projection(req.query)).lean();
      if (!data) throw new ApiError(404, `${Model.modelName} not found.`);
      res.json({ message: 'OK', data });
    });
    router.put(`/${path}/:id`, async (req, res) => {
      res.json({ message: 'Updated', data: await write(req.body, req.params.id) });
    });
    router.delete(`/${path}/:id`, async (req, res) => {
      await remove(req.params.id);
      // HTTP 204 cannot carry a response body; other responses use the envelope.
      res.status(204).end();
    });
  }
  app.use('/api', router);
};
