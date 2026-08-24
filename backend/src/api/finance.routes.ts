import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { ingestRouter } from "../modules/finance/ingest/routes";
import { understandRouter } from "../modules/finance/understand/routes";
import { extractRouter } from "../modules/finance/extract/routes";
import { normalizeRouter } from "../modules/finance/normalize/routes";
import { reconcileRouter } from "../modules/finance/reconcile/routes";
import { exceptionsRouter } from "../modules/finance/exceptions/routes";

export const financeRouter = Router();

// Apply authentication middleware to all finance pipeline routes
financeRouter.use(requireAuth);

// Mount all module sub-routers
financeRouter.use(ingestRouter);
financeRouter.use(understandRouter);
financeRouter.use(extractRouter);
financeRouter.use(normalizeRouter);
financeRouter.use(reconcileRouter);
financeRouter.use(exceptionsRouter);
