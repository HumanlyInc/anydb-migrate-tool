export interface SourceRow {
  rowNumber: number;
  values: Record<string, unknown>;
}

export interface SourceReader {
  read(): Promise<SourceRow[]>;
}
