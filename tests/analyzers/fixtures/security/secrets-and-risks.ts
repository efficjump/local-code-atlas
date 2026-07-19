const githubToken = "__SYNTHETIC_VENDOR_TOKEN__";
const runtimeSecret = process.env.RUNTIME_SECRET;

export const transport = {
  rejectUnauthorized: false,
};

export async function findUser(database: { query(sql: string): unknown }, email: string) {
  return database.query(`SELECT * FROM users WHERE email = '${email}'`);
}

export function echoToken(input: { token: string }) {
  return input.token;
}

void githubToken;
void runtimeSecret;
