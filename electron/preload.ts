import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("fluely", {
  version: "0.1.0",
});
