'use strict';

const path = require('path');
const fs = require('fs');
const url = require('url');
const _ = require('lodash');
const express = require('express');
const bodyParser = require('body-parser');
const Watchpack = require('watchpack');
const rekit = require('rekit-core');
const fetchProjectData = require('./api/fetchProjectData');
const getFileContent = require('./api/getFileContent');
const execCmd = require('./api/execCmd');
const saveFile = require('./api/saveFile');
const runBuild = require('./api/runBuild');
const runTest = require('./api/runTest');
const lint = require('./api/lint');
const element = require('./api/element');
const format = require('./api/format');
const fetchDeps = require('./api/fetchDeps');
const fetchDepsRemote = require('./api/fetchDepsRemote');
const installPackage = require('./api/installPackage');
const updatePackage = require('./api/updatePackage');
const removePackage = require('./api/removePackage');

// const utils = rekitCore.utils;
console.log('rekit: ', rekit.core.paths.getProjectRoot());

// rekitCore.utils.setProjectRoot('/Users/pwang7/workspace/app-hasura');
// rekitCore.plugin.loadPlugins(rekitCore);

let lastProjectData = null;
module.exports = () => {
  // eslint-disable-line
  let io = null;

  const bgProcesses = {};

  const wp = new Watchpack({
    // options:
    aggregateTimeout: 1000,
    // fire "aggregated" event when after a change for 1000ms no additonal change occured
    // aggregated defaults to undefined, which doesn't fire an "aggregated" event

    poll: false,
    // poll: true - use polling with the default interval
    // poll: 10000 - use polling with an interval of 10s
    // poll defaults to undefined, which prefer native watching methods
    // Note: enable polling when watching on a network path

    ignored: /node_modules/,
    // anymatch-compatible definition of files/paths to be ignored
    // see https://github.com/paulmillr/chokidar#path-filtering
  });

  // Watchpack.prototype.watch(string[] files, string[] directories, [number startTime])
  // Watch src files change only
  wp.watch(
    [],
    [
      path.join(rekit.core.paths.getProjectRoot(), 'src'),
      path.join(rekit.core.paths.getProjectRoot(), 'tests'),
      path.join(rekit.core.paths.getProjectRoot(), 'coverage'),
    ],
    Date.now() - 10
  );
  // starts watching these files and directories
  // calling this again will override the files and directories

  wp.on('aggregated', changes => {
    // changes: an array of all changed files
    // rekit.vio.reset();
    // const newProjectData = fetchProjectData();
    // if (_.isEqual(newProjectData, lastProjectData)) return;
    // lastProjectData = newProjectData;
    if (io) io.emit('fileChanged', changes);
  });

  const rootPath = '/rekit';

  function setupSocketIo(server) {
    io = require('socket.io')(server);

    io.on('connection', client => {
      client.on('disconnect', () => {
        console.log('socket disconnected');
      });
    });

    io.on('error', err => {
      console.log('socket error', err);
    });
  }

  function reply403(res) {
    res.statusCode = 403;
    res.write('Forbidden: Rekit studio is running on readonly mode.');
    res.end();
  }

  function rekitMiddleware(server, app, args) {
    args = args || {};
    setupSocketIo(server);
    const prjRoot = rekit.core.paths.getProjectRoot();
    app.use('/coverage', express.static(rekit.core.paths.join(prjRoot, 'coverage'), { fallthrough: false }));
    app.use(bodyParser.json({ limit: '5MB' }));
    app.use(bodyParser.urlencoded({ extended: true }));

    return (req, res, next) => {
      const urlObject = url.parse(req.originalUrl);
      const p = urlObject.pathname.replace(rootPath, '');
      try {
        switch (p) {
          case '/api/element':
            element(req, res);
            break;
          case '/api/project-data': {
            lastProjectData = rekit.core.app.getProjectData();
            res.setHeader('content-type', 'application/json');
            res.write(
              JSON.stringify(
                Object.assign(
                  {
                    bgProcesses,
                  },
                  lastProjectData
                )
              )
            );
            res.end();
            break;
          }
          case '/api/format-code': {
            format(req, res);
            break;
          }
          case '/api/fetchDepsRemote': {
            try {
              fetchDepsRemote().then(data => {
                res.write(JSON.stringify(data));
                res.end();
              });
            } catch (e) {
              res.statusCode = 500;
              res.write(JSON.stringify({ error: e.toString() }));
              res.end();
            }
            break;
          }
          case '/api/fetchDeps': {
            try {
              res.write(JSON.stringify(fetchDeps()));
              res.end();
            } catch (e) {
              res.statusCode = 500;
              res.write(JSON.stringify({ error: e.toString() }));
              res.end();
            }
            break;
          }
          case '/api/lint':
            lint(req, res);
            break;
          case '/api/save-file': {
            if (args.readonly) {
              reply403(res);
              break;
            }
            const absPath = rekit.core.paths.join(prjRoot, req.body.file);
            if (!_.startsWith(absPath, prjRoot)) {
              // prevent ../.. in req.query.file
              res.statusCode = 403;
              res.write('Forbidden: not allowed to access file out of the project.');
              res.end();
              break;
            }

            if (!fs.existsSync(absPath)) {
              res.statusCode = 404;
              res.write(JSON.stringify({ error: 'Not found.' }));
              res.end();
            } else {
              try {
                saveFile(absPath, req.body.content);
                res.write(JSON.stringify({ success: true }));
              } catch (err) {
                res.write(JSON.stringify({ error: err }));
              }
              res.end();
            }
            break;
          }
          case '/api/file-content': {
            const absPath = rekit.core.paths.join(prjRoot, req.query.file);
            if (!_.startsWith(absPath, prjRoot)) {
              // prevent ../.. in req.query.file
              res.statusCode = 403;
              res.write('Forbidden: not allowed to access file out of the project.');
              res.end();
              break;
            }

            if (!fs.existsSync(absPath)) {
              res.statusCode = 404;
              res.write(JSON.stringify({ error: 'Not found.' }));
              res.end();
            } else {
              res.write(JSON.stringify({ content: getFileContent(absPath) }));
              res.end();
            }
            break;
          }
          case '/api/exec-cmd':
            if (args.readonly) {
              reply403(res);
              break;
            }
            execCmd(req, res);
            break;
          case '/api/install-package':
            if (args.readonly) {
              reply403(res);
              break;
            }
            bgProcesses.installPackagePending = { name: req.body.name };
            installPackage(io, req.body.name).then(() => {
              bgProcesses.installPackagePending = false;
            });
            res.write('{}');
            res.end();
            break;
          case '/api/update-package':
            if (args.readonly) {
              reply403(res);
              break;
            }
            bgProcesses.updatePackagePending = { name: req.body.name };
            updatePackage(io, req.body.name).then(() => {
              bgProcesses.updatePackagePending = false;
            });
            res.write('{}');
            res.end();
            break;
          case '/api/remove-package':
            if (args.readonly) {
              reply403(res);
              break;
            }
            bgProcesses.removePackagePending = { name: req.body.name };
            removePackage(io, req.body.name).then(() => {
              bgProcesses.removePackagePending = false;
            });
            res.write('{}');
            res.end();
            break;
          case '/api/run-build':
            if (args.readonly) {
              reply403(res);
              break;
            }
            if (bgProcesses.runningBuild) {
              res.statusCode = 500;
              res.write(JSON.stringify({ error: 'Build process is running...' }));
              res.end();
            } else {
              bgProcesses.runningBuild = true;
              runBuild(io)
                .then(() => {
                  bgProcesses.runningBuild = false;
                })
                .catch(() => {
                  bgProcesses.runningBuild = false;
                });
              res.write('{}');
              res.end();
            }
            break;
          case '/api/run-test':
            if (args.readonly) {
              reply403(res);
              break;
            }
            if (bgProcesses.runningTest) {
              res.statusCode = 500;
              res.write(JSON.stringify({ error: 'Test process is running...' }));
              res.end();
            } else {
              bgProcesses.runningTest = true;
              runTest(io, req.body.testFile || '')
                .then(() => {
                  bgProcesses.runningTest = false;
                })
                .catch(() => {
                  bgProcesses.runningTest = false;
                });
              res.write('{}');
              res.end();
            }
            break;
          default: {
            if (/^\/api\//.test(p)) {
              res.statusCode = 404;
              res.write(JSON.stringify({ error: `API not found: ${p}` }));
              res.end();
            } else {
              next();
            }
            break;
          }
        }
      } catch (e) {
        res.statusCode = 500;
        res.write(e.toString());
        res.end();
      }
    };
  }
  return rekitMiddleware;
};
