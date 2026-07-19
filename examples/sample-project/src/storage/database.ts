export const database = {
  async query(statement: string, values: unknown[] = []) {
    return { statement, values, rows: [] as unknown[] };
  },
};
