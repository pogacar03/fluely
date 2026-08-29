import { contextBridge, ipcRenderer } from "electron";
import { exposeFluelyApi } from "./preloadBridge";

exposeFluelyApi(contextBridge, ipcRenderer);
