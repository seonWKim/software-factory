// The units' own messages (RFC 0015 §7): each message of controller.events goes back to the unit that takes its
// type (`messages` in its unit file), through the router. The router refuses at startup a type no unit takes.

import type { Envelope } from "../../../shared/envelope.js";
import { defineHandler } from "../../../shared/handler.js";
import type { ControllerContext } from "../../index.js";
import CONTROLLER_EVENTS from "../../topics/controller-events.topic.js";

export default defineHandler<Envelope, ControllerContext>({
  name: "unit-messages",
  accepts: Object.keys(CONTROLLER_EVENTS.messages),
  async handle(m, ctx) {
    await ctx.decisions.receive(m);
  },
});
