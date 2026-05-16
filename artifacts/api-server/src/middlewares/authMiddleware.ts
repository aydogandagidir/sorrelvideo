import { type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import type { AuthUser } from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { clearSession, getSessionId, getSession } from "../lib/auth";

declare global {
  namespace Express {
    interface User extends AuthUser {}

    interface Request {
      isAuthenticated(): this is AuthedRequest;

      user?: User | undefined;
    }

    export interface AuthedRequest {
      user: User;
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  req.isAuthenticated = function (this: Request) {
    return this.user != null;
  } as Request["isAuthenticated"];

  const sid = getSessionId(req);
  if (!sid) {
    next();
    return;
  }

  const session = await getSession(sid);
  if (!session?.userId) {
    await clearSession(res, sid);
    next();
    return;
  }

  const [row] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, session.userId));

  if (!row) {
    await clearSession(res, sid);
    next();
    return;
  }

  req.user = {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    profileImageUrl: row.profileImageUrl,
  };
  next();
}
