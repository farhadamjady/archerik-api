import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Makes one promise true everywhere: **every non-2xx body is `{ "error": "<string>" }`**.
 *
 * The UI renders that string verbatim, so the shape has to hold for
 * errors we never wrote by hand. Without this filter it held only for the exceptions we raise
 * ourselves; two common failures still emitted framework defaults:
 *
 *   - **ValidationPipe** → `{statusCode, message: [...], error: "Bad Request"}`. Reading `error`
 *     verbatim showed the user the words "Bad Request" while the useful text sat in `message`.
 *   - **ThrottlerGuard** → `{statusCode, message: "..."}` with no `error` key at all, so the UI
 *     had nothing to render.
 *
 * `message` wins over `error` because Nest's own object bodies carry BOTH — `message` holds the
 * real explanation and `error` holds the reason phrase. Our hand-written bodies carry only
 * `error`, so they pass through untouched.
 *
 * The extractor's `/v1/*` routes are covered too. Safe: the Go CLI switches on status and never
 * decodes an error body, and `{error}` is the shape its own reference server already returns.
 */
@Catch()
export class ErrorBodyFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorBody');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // Nest's default filter logs unhandled errors; replacing it means we have to. Without this,
    // a 500's stack trace would vanish and leave only the generic string the client gets.
    if (!(exception instanceof HttpException)) {
      this.logger.error(
        exception instanceof Error ? exception.message : String(exception),
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    res.status(status).json({ error: messageFor(exception) });
  }
}

function messageFor(exception: unknown): string {
  if (!(exception instanceof HttpException)) {
    // Never surface an unexpected error's text: it can quote a query, a path, or a secret.
    return 'Internal server error';
  }

  const body = exception.getResponse();
  if (typeof body === 'string') return body;

  if (typeof body === 'object' && body !== null) {
    const { message, error } = body as { message?: unknown; error?: unknown };

    // ValidationPipe reports one string per failed rule; joining keeps them all, since which
    // field failed is exactly what the user needs to know.
    if (Array.isArray(message)) {
      const parts = message.filter((m): m is string => typeof m === 'string');
      if (parts.length > 0) return parts.join('; ');
    }
    if (typeof message === 'string' && message.length > 0) return message;
    if (typeof error === 'string' && error.length > 0) return error;
  }

  return 'Request failed';
}
