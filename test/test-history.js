/*global angular*/
(function() {
  'use strict';

  var Q = window.QUnit;

  var init = {
    setup: function() {
      var $injector = angular.injector(['ng', 'decipher.history', 'ngMock']);
      this.History = $injector.get('History');

    },
    teardown: function() {
      delete this.History;
    }
  };

  Q.module('angular-history', init);

  Q.test('_archive', function() {
    Q.ok(angular.isFunction(this.History._archive()), '_archive returns function');
  });
})();
