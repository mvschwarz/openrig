import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import { SeatStatusService } from "../domain/seat-status-service.js";

export const seatRoutes = new Hono();

seatRoutes.get("/status/:seatRef", (c) => {
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  const service = new SeatStatusService({ rigRepo });
  const result = service.getStatus(decodeURIComponent(c.req.param("seatRef")!));

  if (result.ok) {
    return c.json(result.status);
  }

  if (result.code === "seat_ambiguous") {
    return c.json(result, 409);
  }
  if (result.code === "seat_ref_required") {
    return c.json(result, 400);
  }
  return c.json(result, 404);
});
