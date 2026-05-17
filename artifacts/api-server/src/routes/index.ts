import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import templatesRouter from "./templates";
import projectsRouter from "./projects";
import brandRouter from "./brand";
import modulesRouter from "./modules";
import statsRouter from "./stats";
import billingRouter from "./billing";
import storageRouter from "./storage";
import aiRouter from "./ai";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(templatesRouter);
router.use(projectsRouter);
router.use(brandRouter);
router.use(modulesRouter);
router.use(statsRouter);
router.use(billingRouter);
router.use(storageRouter);
router.use(aiRouter);

export default router;
