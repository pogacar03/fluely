export interface ApplicationBootstrapOptions<TContext, TWindow> {
  prepare(): Promise<TContext>;
  createWindow(context: TContext): TWindow;
  initializeWindow(window: TWindow, context: TContext): void | Promise<void>;
  loadRenderer(window: TWindow, context: TContext): void | Promise<void>;
  disposeWindow?(window: TWindow): void;
}

/**
 * Runs all process-wide preparation before creating a renderer-bearing window.
 * A window-specific failure is still fail-closed: its renderer is never loaded.
 */
export async function bootstrapApplication<TContext, TWindow>(
  options: ApplicationBootstrapOptions<TContext, TWindow>,
): Promise<TWindow> {
  const context = await options.prepare();
  const window = options.createWindow(context);

  try {
    await options.initializeWindow(window, context);
    await options.loadRenderer(window, context);
    return window;
  } catch (error) {
    try {
      options.disposeWindow?.(window);
    } catch {
      // Preserve the initialization/load failure as the actionable error.
    }
    throw error;
  }
}
