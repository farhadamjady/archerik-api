/** The authenticated principal attached to each request by AuthGuard. */
export interface AuthUser {
  id: string;
  /** The account (company) this user belongs to — the scope of every read endpoint. */
  accountId: string;
  email: string;
  name: string;
  handle: string;
  team: string;
}

/** Public user shape returned by /auth/login and /me — never includes the password hash. */
export interface PublicUser {
  name: string;
  handle: string;
  team: string;
}

export interface LoginResponse {
  token: string;
  user: PublicUser;
}
