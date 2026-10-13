'use strict';

// Errors that the CLI prints as-is (the message is already user-facing Spanish)
class DriverError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DriverError';
    this.code = code || 'EDRIVER';
  }
}

module.exports = { DriverError: DriverError };
