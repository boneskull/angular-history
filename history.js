/*global angular*/

/**
 * It's a history service.
 *
 * Watches are registered against the scope if you pass it, otherwise $rootScope.
 */
(function () {
  'use strict';

  var DEEPWATCH_EXP = /^\s*(.*?)\s+for\s+(?:([\$\w][\$\w\d]*)|(?:\(\s*([\$\w][\$\w\d]*)\s*,\s*([\$\w][\$\w\d]*)\s*\)))\s+in\s+(.*?)$/,
    DEFAULT_TIMEOUT = 1000,
    lazyBindFound = false;

  // stub out lazyBind if we don't have it.
  try {
    angular.module('lazyBind');
    lazyBindFound = true;
  }
  catch (e) {
    angular.module('lazyBind', []).factory('$lazyBind', angular.noop);
  }


  angular.module('decipher.history', ['lazyBind']).service('History',
    function ($parse, $rootScope, $interpolate, $lazyBind, $timeout, $log,
      $injector) {
      var history = {},
        pointers = {},
        watches = {},
        watchObjs = {},
        lazyWatches = {},
        descriptions = {},
        batching = false,
        deepWatchId = 0;

      var Watch = function Watch() {
        this._changeHandlers = {};
        this._undoHandlers = {};
        this._rollbackHandlers = {};
        this._redoHandlers = {};
        this._revertHandlers = {};
      };

      Watch.prototype._addHandler =
      function _addHandler(where, name, fn, resolve) {
        if (!where || !name || !fn) {
          throw 'invalid parameters to _addHandler()';
        }
        this[where][name] = {
          fn: fn,
          resolve: resolve
        };
      };

      Watch.prototype._removeHandler = function (where, name) {
        var ch;
        if (!name) {
          throw 'invalid parameters to _removeHandler()';
        }
        ch = this[where][name];
        delete this[where][name];
        return ch;
      };

      Watch.prototype.addChangeHandler =
      function addChangeHandler(name, fn, resolve) {
        this._addHandler('_changeHandlers', name, fn, resolve);
      };

      Watch.prototype.addUndoHandler =
      function addUndoHandler(name, fn, resolve) {
        this._addHandler('_undoHandlers', name, fn, resolve);
      };

      Watch.prototype.addRedoHandler =
      function addRedoHandler(name, fn, resolve) {
        this._addHandler('_redoHandlers', name, fn, resolve);
      };

      Watch.prototype.addRevertHandler =
      function addRevertHandler(name, fn, resolve) {
        this._addHandler('_revertHandlers', name, fn, resolve);
      };

      Watch.prototype.addRollbackHandler =
      function addRollbackHandler(name, fn, resolve) {
        this._addHandler('_rollbackHandlers', name, fn, resolve);
      };

      Watch.prototype.removeRevertHandler = function removeRevertHandler(name) {
        return this._removeHandler('_revertHandlers', name);
      };

      Watch.prototype.removeChangeHandler = function removeChangeHandler(name) {
        return this._removeHandler('_changeHandlers', name);
      };

      Watch.prototype.removeUndoHandler = function removeUndoHandler(name) {
        return this._removeHandler('_undoHandlers', name);
      };

      Watch.prototype.removeRollbackHandler =
      function removeRollbackHandler(name) {
        return this._removeHandler('_rollbackHandlers', name);
      };

      Watch.prototype._fireHandlers = function _fireHandlers(where, scope) {
        var hasScope = angular.isDefined(scope);
        angular.forEach(this[where], function (handler) {
          var locals = {};
          angular.forEach(handler.resolve, function (value, key) {
            if (hasScope) {
              locals[key] = $parse(value)(scope);
            } else {
              locals[key] = value;
            }
          });
          $injector.invoke(handler.fn, scope || this, locals);
        });
      };

      Watch.prototype._fireChangeHandlers =
      function _fireChangeHandlers(scope) {
        this._fireHandlers('_changeHandlers', scope);
      };

      Watch.prototype._fireUndoHandlers = function _fireUndoHandlers(scope) {
        this._fireHandlers('_undoHandlers', scope);
      };

      Watch.prototype._fireRedoHandlers = function _fireRedoHandlers(scope) {
        this._fireHandlers('_redoHandlers', scope);
      };

      Watch.prototype._fireRevertHandlers =
      function _fireRevertHandlers(scope) {
        this._fireHandlers('_revertHandlers', scope);
      };

      Watch.prototype._fireRollbackHandlers = function _fireRollbackHandlers() {
        this._fireHandlers('_rollbackHandlers');
      };

      /**
       * Evaluates an expression on the scope lazily.  That means it will return
       * a new value every DEFAULT_TIMEOUT ms at maximum, even if you change it between
       * now and then.  This allows us to $broadcast at an interval instead of after
       * every scope change.
       * @param {Scope} scope AngularJS Scope
       * @param {string} exp AngularJS expression to evaluate
       * @param {number} [timeout=DEFAULT_TIMEOUT] How often to change the value
       * @returns {Function}
       */
      var lazyWatch = function lazyWatch(scope, exp, timeout) {
        var bind = $lazyBind(scope);
        bind.cacheTime(timeout || DEFAULT_TIMEOUT);

        /**
         * This is the "expression function" we use to $watch with.  You normally
         * $watch a string, but you can also watch a function, and this is one of
         * those functions.  This is where the actual lazy evaluation happens.
         */
        return function () {
          return bind.call(scope, exp);
        };
      };

      /**
       * When an expression changes, store the information about it
       * and increment a pointer.
       * @param exp Expression
       * @param id Scope $id
       * @param {Scope} locals AngularJS scope
       * @param {boolean} pass Whether or not to pass on the first call
       * @param {string} description AngularJS string to interpolate
       * @return {Function} Watch function
       * @private
       */
      this._archive = function (exp, id, locals, pass, description) {
        return function (newVal, oldVal) {
          var watchId;
          if (description) {
            descriptions[id][exp] = $interpolate(description)(locals);
          }
          if (pass) {
            pass = false;
            return;
          }
          // initializing a bunch of crap
          if (angular.isUndefined(history[id])) {
            history[id] = {};
          }
          if (angular.isUndefined(pointers[id])) {
            pointers[id] = {};
          }
          if (angular.isUndefined(history[id][exp])) {
            history[id][exp] = [];
          }
          if (angular.isUndefined(pointers[id][exp])) {
            pointers[id][exp] = 0;
          }
          history[id][exp].splice(pointers[id][exp] + 1);
          history[id][exp].push(angular.copy(newVal));
          pointers[id][exp] = history[id][exp].length - 1;
          if (pointers[id][exp] > 0) {
            watchId = locals.$$deepWatchId ? locals.$parent.$id : locals.$id;
            if (!batching && angular.isDefined(watchObjs[watchId]) &&
                angular.isDefined(watchObjs[watchId][exp])) {
              watchObjs[watchId][exp]._fireChangeHandlers(locals);
            }
            $rootScope.$broadcast('History.archived', {
              expression: exp,
              newValue: newVal,
              oldValue: oldVal,
              description: descriptions[id][exp],
              locals: locals
            });
          }
        };
      };

      /**
       * Register some expression(s) for watching.
       * @param exps Array of expressions or one expression as a string
       * @param scope Scope
       * @param {string=} description Description of this change
       * @param {Object=} lazyOptions Options for lazy loading.  Only valid
       * property is 'timeout' at this point
       */
      this.watch = function watch(exps, scope, description, lazyOptions) {
        if (angular.isUndefined(exps)) {
          throw 'expression required';
        }
        scope = scope || $rootScope;
        description = description || '';
        var i,
          id = scope.$id,
          exp,
          model;

        if (!angular.isArray(exps)) {
          exps = [exps];
        }
        if (angular.isUndefined(watches[id])) {
          watches[id] = {};
        }
        if (angular.isUndefined(lazyWatches[id])) {
          lazyWatches[id] = {};
        }
        i = exps.length;
        while (i--) {
          exp = exps[i];

          // assert we have an assignable model
          // TODO: better way to do this?
          try {
            model = $parse(exp);
            model.assign(scope, model(scope));
          } catch (e) {
            throw 'expression "' + exp +
                  '" is not an assignable expression';
          }

          // blast any old watches
          if (angular.isFunction(watches[id][exp])) {
            watches[id][exp]();
          }

          if (!descriptions[id]) {
            descriptions[id] = {};
          }
          descriptions[id][exp] = $interpolate(description)(scope);

          this._watch(exp, scope, false, lazyOptions);

        }
        if (angular.isUndefined(watchObjs[id])) {
          watchObjs[id] = {};
        }
        return watchObjs[id][exp] = new Watch();
      };

      /**
       * Allows you to watch an entire array/object full of objects, but only watch
       * a certain property of each object.  Usage:
       *
       *      History.deepWatch('foo.bar for foo in foos', $scope,
       *          'Changed foo {{foo.baz}}', {timeout: 1000});
       *
       *      History.deepWatch('key' + ': ' + val[key] for key, val in foos' ..)
       *
       *
       * @param exp
       * @param scope
       * @param description
       * @param lazyOptions
       */
      this.deepWatch =
      function deepWatch(exp, scope, description, lazyOptions) {
        var match,
          targetName,
          valueFn,
          keyName,
          valuesFn,
          values,
          value,
          valueName,
          valuesName,
          _clear = this._clear,
          _archive = this._archive;
        description = description || '';
        if (!(match = exp.match(DEEPWATCH_EXP))) {
          throw new Error('expected expression in form of "_select_ for (_key_,)? _value_ in _collection_" but got "' +
                          exp + '"');
        }
        targetName = match[1];
        valueName = match[4] || match[2];
        valueFn = $parse(valueName);
        keyName = match[3];
        valuesName = match[5];
        valuesFn = $parse(valuesName);
        values = valuesFn(scope);

        if (angular.isUndefined(scope.$$deepWatch)) {
          scope.$$deepWatch = {};
        }
        scope.$$deepWatch[exp] = ++deepWatchId;

        angular.forEach(values, function (v, k) {
          var locals = scope.$new(),
            id = locals.$id;
          locals.$$deepWatchId = scope.$$deepWatch[exp];
          locals.$$deepWatchTargetName = targetName;
          locals[valueName] = v;
          if (keyName) {
            locals[keyName] = k;
          }
          value = valueFn(scope, locals);

          if (!watches[id]) {
            watches[id] = {};
          }
          if (!lazyWatches[id]) {
            lazyWatches[id] = {};
          }
          if (!descriptions[id]) {
            descriptions[id] = {};
          }
          descriptions[id][exp] = $interpolate(description)(locals);

          if (angular.isObject(lazyOptions) && lazyBindFound) {
            watches[id][targetName] =
            locals.$watch(lazyWatch(locals, targetName,
              lazyOptions.timeout || 500),
              _archive(targetName, id, locals, false, description));
            lazyWatches[id][exp] = true;
          }
          else {
            watches[id][targetName] = locals.$watch(targetName,
              _archive(targetName, id, locals, false, description));
            lazyWatches[id][exp] = false;
          }

          locals.$on('$destroy', function () {
            _clear(locals);
          });

        });

        if (angular.isUndefined(watchObjs[scope.$id])) {
          watchObjs[scope.$id] = {};
        }

        return watchObjs[scope.$id][targetName] = new Watch();
      };

      this._clear = function _clear(scope, exps) {
        var id = scope.$id,
          i,
          exp,
          childHead,
          nextSibling,
          dwid;

        function clear(id, exp) {
          angular.forEach(watches[id], function (watch) {
            if (angular.isFunction(watch)) {
              watch();
            }
          });
          if (angular.isDefined(watches[id]) &&
              angular.isFunction(watches[id][exp])) {
            watches[id][exp]();
          }
          if (angular.isDefined(watches[id])) {
            delete watches[id][exp];
          }
          if (angular.isDefined(history[id])) {
            delete history[id][exp];
          }
          if (angular.isDefined(pointers[id])) {
            delete pointers[id][exp];
          }
          if (angular.isDefined(lazyWatches[id])) {
            delete lazyWatches[id][exp];
          }

        }

        exps = angular.isArray(exps) ? exps : Object.keys(watches[id]);

        i = exps.length;
        while (i--) {
          exp = exps[i];
          clear(id, exp);
          if (angular.isDefined(scope.$$deepWatch)) {
            // find children.
            dwid = scope.$$deepWatch[exp];
            childHead = scope.$$childHead;
            if (childHead) {
              if (childHead.$$deepWatchId === dwid) {
                clear(childHead.$id, childHead.$$deepWatchTargetName);
              }
              nextSibling = childHead;
              while (nextSibling = nextSibling.$$nextSibling) {
                // I guess $$nextSibling is an infinite loop
                if (nextSibling.$$deepWatchId === dwid) {
                  clear(nextSibling.$id, childHead.$$deepWatchTargetName);
                }
              }
            }
          }
        }
      };


      /**
       * Unregister some watched expression(s)
       * @param exps Array of expressions or one expression as a string
       * @param scope Scope
       */
      this.forget = function forget(exps, scope) {
        scope = scope || $rootScope;
        if (!angular.isArray(exps) && angular.isString(exps)) {
          exps = [exps];
        }
        this._clear(scope, exps);
      };

      /**
       * Internal function to change some value in the stack to another.
       * @param scope
       * @param exp
       * @param stack
       * @param pointer
       * @returns {{oldValue: *, newValue: null}}
       * @private
       */
      this._do = function _do(scope, exp, stack, pointer) {
        var model,
          oldValue,
          id = scope.$id;
        if (angular.isFunction(watches[id][exp])) {
          watches[id][exp]();
          delete watches[id][exp];
        }
        model = $parse(exp);
        oldValue = model(scope);
        model.assign(scope, stack[pointer]);
        this._watch(exp, scope, true);
        return {
          oldValue: oldValue,
          newValue: model(scope)
        };
      };

      /**
       * Undos an expression to last known value.
       * @param exp Expression
       * @param scope Scope
       */
      this.undo = function undo(exp, scope) {
        scope = scope || $rootScope;
        if (angular.isUndefined(exp)) {
          throw 'expression required';
        }
        var id = scope.$id,
          scopeHistory = history[id],
          stack,
          values,
          pointer,
          watchId;

        if (angular.isUndefined(scopeHistory)) {
          throw 'could not find history for scope ' + id;
        }

        stack = scopeHistory[exp];
        if (angular.isUndefined(stack)) {
          throw 'could not find history in scope "' + id +
                ' against expression "' + exp + '"';
        }
        pointer = --pointers[id][exp];
        if (pointer < 0) {
          $log.warn('attempt to undo past history');
          pointers[id][exp]++;
          return;
        }
        values = this._do(scope, exp, stack, pointer);

        watchId = scope.$$deepWatchId ? scope.$parent.$id : scope.$id;
        if (angular.isDefined(watchObjs[watchId]) &&
            angular.isDefined(watchObjs[watchId][exp])) {
          watchObjs[watchId][exp]._fireUndoHandlers(scope);
        }

        $rootScope.$broadcast('History.undone', {
          expression: exp,
          newValue: values.newValue,
          oldValue: values.oldValue,
          description: descriptions[id][exp],
          scope: scope
        });


      };

      /**
       * Actually issues the appropriate scope.$watch
       * @param exp
       * @param scope
       * @param lazyOptions
       * @param pass
       * @private
       */
      this._watch = function _watch(exp, scope, pass, lazyOptions) {
        var id;
        scope = scope || $rootScope;
        pass = pass || false;
        id = scope.$id;

        // do we have an array or object?
        if (lazyBindFound && (angular.isObject(lazyOptions) ||
                              (lazyWatches[id] && !!lazyWatches[id][exp]))) {
          watches[id][exp] =
          scope.$watch(lazyWatch(scope, exp, lazyOptions.timeout),
            this._archive(exp, id, scope, pass), true);
          lazyWatches[id][exp] = true;
        }
        else {
          watches[id][exp] =
          scope.$watch(exp, this._archive(exp, id, scope, pass), true);
          lazyWatches[id][exp] = false;
        }

      };

      /**
       * Redos an expression.
       * @param exp Expression
       * @param scope Scope
       */
      this.redo = function redo(exp, scope) {
        scope = scope || $rootScope;
        var id = scope.$id,
          stack = history[id][exp],
          values,
          pointer,
          watchId;
        if (angular.isUndefined(stack)) {
          throw 'could not find history in scope "' + id +
                ' against expression "' + exp + '"';
        }
        pointer = ++pointers[id][exp];
        if (pointer === stack.length) {
          $log.warn('attempt to redo past history');
          pointers[id][exp]--;
          return;
        }

        values = this._do(scope, exp, stack, pointer);

        watchId = scope.$$deepWatchId ? scope.$parent.$id : scope.$id;
        if (angular.isDefined(watchObjs[watchId]) &&
            angular.isDefined(watchObjs[watchId][exp])) {
          watchObjs[watchId][exp]._fireRedoHandlers(scope);
        }

        $rootScope.$broadcast('History.redone', {
          expression: exp,
          oldValue: angular.copy(values.newValue),
          newValue: angular.copy(values.oldValue),
          description: descriptions[id][exp],
          scope: scope
        });

      };

      /**
       * Whether or not we have accumulated any history for a particular expression.
       * @param exp Expression
       * @param scope Scope
       * @return {Boolean}
       */
      this.canUndo = function canUndo(exp, scope) {
        scope = scope || $rootScope;
        return angular.isDefined(pointers[scope.$id]) &&
               pointers[scope.$id][exp] > 0;
      };

      /**
       * Whether or not we can redo something
       * @param exp Expression
       * @param scope Scope
       * @returns {Boolean}
       */
      this.canRedo = function canRedo(exp, scope) {
        var id;
        scope = scope || $rootScope;
        id = scope.$id;
        return angular.isDefined(pointers[id]) &&
               angular.isDefined(pointers[id][exp]) &&
               pointers[id][exp] < history[id][exp].length - 1;
      };

      /**
       * Reverts to earliest known value of some expression.
       * @param exp Expression
       * @param scope Scope
       * @param {number} [pointer=0]
       */
      this.revert = function (exp, scope, pointer) {
        scope = scope || $rootScope;
        pointer = pointer || 0;
        var id = scope.$id,
          stack = history[id][exp],
          values,
          watchId;
        if (angular.isUndefined(stack)) {
          $log.warn('nothing to revert');
          return;
        }
        values = this._do(scope, exp, stack, pointer);

        // wait; what is this?
        history[scope.$id][exp].splice();
        pointers[scope.$id][exp] = pointer;

        watchId = scope.$$deepWatchId ? scope.$parent.$id : scope.$id;
        if (angular.isDefined(watchObjs[watchId]) &&
            angular.isDefined(watchObjs[watchId][exp])) {
          watchObjs[watchId][exp]._fireChangeHandlers(scope);
        }

        $rootScope.$broadcast('History.reverted', {
          expression: exp,
          oldValue: angular.copy(values.newValue),
          newValue: angular.copy(values.oldValue),
          description: descriptions[id][exp],
          scope: scope,
          pointer: pointer
        });
      };

      this.batch = function batch(fn, scope, description) {
        var _clear = this._clear,
          listener,
          child;
        if (!angular.isFunction(fn)) {
          throw 'transaction requires a function';
        }
        if (!angular.isObject(scope)) {
          throw 'transaction requires a scope';
        }

        child = scope.$new();
        child.$on('$destroy', function () {
          _clear(child);
        });

        listener = scope.$on('History.archived', function (evt, data) {
          var deepChild,
            exp = data.expression,
            id;
          if (data.locals.$id !== child.$id) {
            deepChild = child.$new();
            deepChild.$on('$destroy', function () {
              _clear(deepChild);
            });
            deepChild.$$locals = data.locals;
            id = deepChild.$id;
            history[id] = {};
            pointers[id] = {};
            history[id][exp] =
            angular.copy(history[data.locals.$id][exp]);
            pointers[id][exp] = pointers[data.locals.$id][exp] - 1;
          }
        });

        $rootScope.$broadcast('History.batchBegan', {
          transaction: child,
          description: description
        });

        // we need to put this into a timeout and apply manually
        // since it's not clear when the watchers will get fired,
        // and we must ensure that any existing watchers on the archived
        // event can be skipped before the batchEnd occurs.
        batching = true;
        $timeout(function () {
          fn(child);
          scope.$apply();
        }).then(function () {
            listener();
            batching = false;
            $rootScope.$broadcast('History.batchEnded', {
              transaction: child,
              description: description
            });
          });

        return watchObjs[child.$id] = new Watch();
      };

      this.rollback = function rollback(t) {

        var _do = angular.bind(this, this._do),
          parent = t.$parent,
          packets = {},
          childHead,
          childHeadLocals,
          nextSibling,
          nextSiblingLocals;
        if (!t || !angular.isObject(t)) {
          throw 'must pass a transactional scope to rollback'
        }

        function _rollback(scope, comparisonScope) {
          var id = scope.$id,
            comparisonScopeId = comparisonScope.$id,
            stack = history[id],
            pointer,
            descs,
            exp,
            values,
            exps,
            rolledback,
            i;
          if (stack) {
            exps = Object.keys(stack);
            i = exps.length;
          } else {
            return;
          }
          while (i--) {
            exp = exps[i];
            values = [];
            descs = [];
            pointer = pointers[comparisonScopeId][exp];
            rolledback = false;
            while (pointer > pointers[id][exp]) {
              pointer--;
              values.push(_do(comparisonScope,
                exp, history[comparisonScopeId][exp], pointer));
              pointers[comparisonScopeId][exp] = pointer;
              descs.push(descriptions[comparisonScopeId][exp]);
              // throw this off the history stack so
              // we don't end up with it in the stack while we
              // do normal undo() calls later against the same
              // expression and scope
              history[comparisonScopeId][exp].pop();
              rolledback = true;
            }
            if (rolledback) {
              packets[exp] = {
                values: values,
                scope: scope,
                comparisonScope: comparisonScope,
                descriptions: descs
              };
            }
          }
        }

        if (angular.isDefined(parent) &&
            angular.isDefined(history[parent.$id])) {
          _rollback(t, parent);
        }
        childHead = t.$$childHead;
        if (childHead) {
          childHeadLocals = childHead.$$locals;
          if (childHeadLocals) {
            _rollback(childHead, childHeadLocals);
          }
          nextSibling = childHead;
          while (nextSibling = nextSibling.$$nextSibling) {
            nextSiblingLocals = nextSibling.$$locals;
            if (nextSiblingLocals) {
              _rollback(nextSibling, nextSiblingLocals);
            }
          }
        }

        watchObjs[t.$id]._fireRollbackHandlers();

        $rootScope.$broadcast('History.rolledback', packets);

      };

      // expose for debugging/testing
      this.history = history;
      this.descriptions = descriptions;
      this.pointers = pointers;
      this.watches = watches;
      this.lazyWatches = lazyWatches;
    });
})();
