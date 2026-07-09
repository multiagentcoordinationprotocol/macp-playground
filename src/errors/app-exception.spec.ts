import { HttpException, HttpStatus } from '@nestjs/common';
import { AppException } from './app-exception';
import { ErrorCode } from './error-codes';

describe('AppException', () => {
  it('defaults to HTTP 500 when no status is given', () => {
    const exception = new AppException(ErrorCode.INTERNAL_ERROR, 'boom');

    expect(exception.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('carries the given HTTP status and exposes errorCode', () => {
    const exception = new AppException(ErrorCode.PACK_NOT_FOUND, 'pack missing', HttpStatus.NOT_FOUND);

    expect(exception.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(exception.errorCode).toBe(ErrorCode.PACK_NOT_FOUND);
  });

  it('shapes the response body as { statusCode, errorCode, message }', () => {
    const exception = new AppException(ErrorCode.VALIDATION_ERROR, 'inputs invalid', HttpStatus.BAD_REQUEST);

    expect(exception.getResponse()).toEqual({
      statusCode: HttpStatus.BAD_REQUEST,
      errorCode: ErrorCode.VALIDATION_ERROR,
      message: 'inputs invalid'
    });
  });

  it('includes metadata in the response body only when provided', () => {
    const metadata = { scenarioRef: 'fraud/high-value-new-device@1.0.0' };
    const withMetadata = new AppException(ErrorCode.SCENARIO_NOT_FOUND, 'not found', HttpStatus.NOT_FOUND, metadata);
    const withoutMetadata = new AppException(ErrorCode.SCENARIO_NOT_FOUND, 'not found', HttpStatus.NOT_FOUND);

    expect(withMetadata.getResponse()).toMatchObject({ metadata });
    expect(withMetadata.metadata).toBe(metadata);
    expect(withoutMetadata.getResponse()).not.toHaveProperty('metadata');
    expect(withoutMetadata.metadata).toBeUndefined();
  });

  it('is an HttpException so the global filter and Nest internals handle it uniformly', () => {
    const exception = new AppException(ErrorCode.INVALID_CONFIG, 'bad config');

    expect(exception).toBeInstanceOf(HttpException);
  });
});
