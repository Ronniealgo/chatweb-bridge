import { BridgeError as ProtocolError } from '../protocol.mjs';
export class BridgeError extends ProtocolError {
  constructor(message, status = 400, code = 'invalid_request', details = {}) {
    super(message, status, code);
    this.details = { generation_submitted: false, retryable: false, ...details };
  }
}
