/** The authenticated principal attached to each request by AuthGuard. */
export interface AuthUser {
  id: string;
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
