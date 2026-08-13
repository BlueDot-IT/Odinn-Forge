export class ApplicationContractValidationError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(message: string, code = "INVALID_APPLICATION_CONTRACT", path?: string) {
    super(message);
    this.name = "ApplicationContractValidationError";
    this.code = code;
    this.path = path;
  }
}

export function invalid(message: string, code?: string, path?: string): ApplicationContractValidationError {
  return new ApplicationContractValidationError(message, code, path);
}
