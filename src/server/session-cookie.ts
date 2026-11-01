export const sessionCookie = (production = process.env.NODE_ENV === "production") =>
  production ? "__Host-family_session" : "family_session";

export function expiredSessionCookie(production = process.env.NODE_ENV === "production") {
  return {
    name: sessionCookie(production),
    value: "",
    httpOnly: true,
    // __Host- updates, including expiry, must retain Secure and path=/.
    secure: production,
    sameSite: "lax" as const,
    path: "/",
    expires: new Date(0),
  };
}
