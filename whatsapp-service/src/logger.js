import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ['req.headers["x-service-secret"]', 'req.headers["x-service-secret"]'],
    censor: '[REDACTED]'
  }
});
