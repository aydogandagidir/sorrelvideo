import { Router, type IRouter } from "express";
import healthRouter from "./health";
import templatesRouter from "./templates";
import projectsRouter from "./projects";
import brandRouter from "./brand";
import modulesRouter from "./modules";
import statsRouter from "./stats";

const router: IRouter = Router();

router.use(healthRouter);
router.use(templatesRouter);
router.use(projectsRouter);
router.use(brandRouter);
router.use(modulesRouter);
router.use(statsRouter);

export default router;
