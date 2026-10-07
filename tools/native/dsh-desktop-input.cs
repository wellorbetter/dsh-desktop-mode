// dsh-desktop-input — fast native transitions for the DSH desktop layer.
//
// Why this exists: the shell's own desktop-mode transitions run a generated
// PowerShell script per step (Add-Type costs ~300 ms on this machine, plus
// ~230 ms of powershell.exe startup), which is far too slow for "click the
// composer and start typing". This helper performs the same Win32 work in
// ~30 ms so the layer can leave the desktop, take the keyboard, and drop back
// without a visible pause or a flicker.
//
// It deliberately mirrors what the shell already does natively:
//   attach: SetParent(window, SHELLDLL_DefView) + WS_CHILD
//   detach: SetParent(window, NULL) + WS_POPUP
// so an external process reparenting the Electron window is nothing new here.
//
// Keyboard rules this implements (Windows has no way around them):
//   * only the foreground window's input queue receives keyboard input, and a
//     WS_CHILD of Explorer's desktop view can never become the foreground
//     window — so typing requires leaving the desktop layer;
//   * SetForegroundWindow is refused unless the caller may take the foreground,
//     so the helper merges input queues with the current foreground thread
//     (AttachThreadInput) first, the classic workaround;
//   * on demote the foreground is handed back to the desktop, so the next
//     click anywhere behaves normally.
//
// Usage:
//   dsh-desktop-input.exe status  [--root <project>] [--exe <shell.exe>]
//   dsh-desktop-input.exe promote [--root <project>] [--keep-below]
//   dsh-desktop-input.exe demote  [--root <project>]
//   dsh-desktop-input.exe focus   [--root <project>]
//   dsh-desktop-input.exe send-text <text>   (test only; refuses unless the
//                                             shell window owns the keyboard)
// Prints one line of JSON; exit code 1 when the requested state is not reached.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class DshDesktopInput
{
	// ------------------------------------------------------------------ Win32 --
	private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

	[StructLayout(LayoutKind.Sequential)]
	private struct RECT { public int Left, Top, Right, Bottom; }

	[StructLayout(LayoutKind.Sequential)]
	private struct GUITHREADINFO
	{
		public int cbSize;
		public int flags;
		public IntPtr hwndActive;
		public IntPtr hwndFocus;
		public IntPtr hwndCapture;
		public IntPtr hwndMenuOwner;
		public IntPtr hwndMoveSize;
		public IntPtr hwndCaret;
		public RECT rcCaret;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct MONITORINFO
	{
		public int cbSize;
		public RECT rcMonitor;
		public RECT rcWork;
		public int dwFlags;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct INPUT
	{
		public int type;
		public int padding;
		public KEYBDINPUT ki;
		public long padding2;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct POINT
	{
		public int X;
		public int Y;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct SIZE
	{
		public int cx;
		public int cy;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct BITMAPINFOHEADER
	{
		public int biSize;
		public int biWidth;
		public int biHeight;
		public short biPlanes;
		public short biBitCount;
		public int biCompression;
		public int biSizeImage;
		public int biXPelsPerMeter;
		public int biYPelsPerMeter;
		public int biClrUsed;
		public int biClrImportant;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct BITMAPINFO
	{
		public BITMAPINFOHEADER bmiHeader;
		public int bmiColors;
	}

	[StructLayout(LayoutKind.Sequential, Pack = 1)]
	private struct BLENDFUNCTION
	{
		public byte BlendOp;
		public byte BlendFlags;
		public byte SourceConstantAlpha;
		public byte AlphaFormat;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct KEYBDINPUT
	{
		public ushort wVk;
		public ushort wScan;
		public uint dwFlags;
		public uint time;
		public IntPtr dwExtraInfo;
	}

	[DllImport("user32.dll", SetLastError = true)]
	private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

	[DllImport("user32.dll", SetLastError = true)]
	private static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);

	[DllImport("user32.dll", CharSet = CharSet.Unicode)]
	private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string windowName);

	[DllImport("user32.dll", CharSet = CharSet.Unicode)]
	private static extern int GetClassName(IntPtr hWnd, StringBuilder value, int maxCount);

	[DllImport("user32.dll")]
	private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

	[DllImport("user32.dll")]
	private static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

	[DllImport("user32.dll")]
	private static extern bool IsWindow(IntPtr hWnd);

	[DllImport("user32.dll")]
	private static extern bool IsWindowVisible(IntPtr hWnd);

	[DllImport("user32.dll", SetLastError = true)]
	private static extern IntPtr SetParent(IntPtr child, IntPtr parent);

	[DllImport("user32.dll", SetLastError = true)]
	private static extern IntPtr GetParent(IntPtr child);

	[DllImport("user32.dll", SetLastError = true)]
	private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

	[DllImport("user32.dll")]
	private static extern IntPtr GetForegroundWindow();

	[DllImport("user32.dll", SetLastError = true)]
	private static extern bool SetForegroundWindow(IntPtr hWnd);

	[DllImport("user32.dll", SetLastError = true)]
	private static extern IntPtr SetFocus(IntPtr hWnd);

	[DllImport("user32.dll")]
	private static extern IntPtr SetActiveWindow(IntPtr hWnd);

	[DllImport("user32.dll")]
	private static extern bool BringWindowToTop(IntPtr hWnd);

	[DllImport("user32.dll", SetLastError = true)]
	private static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachFlag);

	[DllImport("user32.dll", SetLastError = true)]
	private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

	[DllImport("kernel32.dll")]
	private static extern uint GetCurrentThreadId();

	[DllImport("user32.dll", SetLastError = true)]
	private static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);

	[DllImport("user32.dll")]
	private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

	[DllImport("user32.dll", CharSet = CharSet.Unicode)]
	private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

	[DllImport("user32.dll")]
	private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

	[DllImport("user32.dll")]
	private static extern IntPtr GetDesktopWindow();

	[DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
	private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int index);

	[DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
	private static extern IntPtr GetWindowLong32(IntPtr hWnd, int index);

	[DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
	private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int index, IntPtr value);

	[DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
	private static extern IntPtr SetWindowLong32(IntPtr hWnd, int index, IntPtr value);

	[DllImport("user32.dll", SetLastError = true)]
	private static extern uint SendInput(uint count, INPUT[] inputs, int size);

	[DllImport("user32.dll", CharSet = CharSet.Unicode)]
	private static extern IntPtr SendMessage(IntPtr hWnd, int message, IntPtr wParam, IntPtr lParam);

	[DllImport("user32.dll")]
	private static extern bool RedrawWindow(IntPtr hWnd, IntPtr updateRect, IntPtr updateRegion, uint flags);

	// --- freeze mask (screen-level double buffering for the composition swap) --
	[DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hWnd);
	[DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hWnd, IntPtr dc);
	[DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr dc, uint flags);
	[DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hWnd);
	[DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint command);
	[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	private static extern IntPtr CreateWindowEx(int exStyle, string className, string windowName, int style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
	[DllImport("user32.dll")]
	private static extern bool UpdateLayeredWindow(IntPtr hWnd, IntPtr destinationDc, ref POINT destinationPoint, ref SIZE size, IntPtr sourceDc, ref POINT sourcePoint, int colorKey, ref BLENDFUNCTION blend, int flags);
	[DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
	[DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
	[DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
	[DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
	[DllImport("gdi32.dll")]
	private static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFO info, uint usage, out IntPtr bits, IntPtr section, uint offset);

	// ------------------------------------------------------------------ state --
	private const int GWL_STYLE = -16;
	private const long WS_CAPTION = 0x00C00000;
	private const long WS_THICKFRAME = 0x00040000;
	private const long WS_DLGFRAME = 0x00400000;
	private const long WS_BORDER = 0x00800000;
	private const long WS_POPUP = 0x80000000;
	private const long WS_CHILD = 0x40000000;
	private const long WS_VISIBLE = 0x10000000;

	private const uint SWP_NOSIZE = 0x0001;
	private const uint SWP_NOMOVE = 0x0002;
	private const uint SWP_NOZORDER = 0x0004;
	private const uint SWP_NOACTIVATE = 0x0010;
	private const uint SWP_FRAMECHANGED = 0x0020;
	private const uint SWP_SHOWWINDOW = 0x0040;

	private const int WM_SETREDRAW = 0x000B;
	private const uint RDW_INVALIDATE = 0x0001;
	private const uint RDW_ALLCHILDREN = 0x0080;
	private const uint RDW_UPDATENOW = 0x0100;

	private static readonly IntPtr HWND_TOP = IntPtr.Zero;
	private static readonly IntPtr HWND_BOTTOM = new IntPtr(1);

	private static string exePath;
	private static string rootPath;
	private static string statePath;

	// ------------------------------------------------------------------- main --
	private static int Main(string[] argv)
	{
		Console.OutputEncoding = new UTF8Encoding(false);
		try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }

		var args = new List<string>(argv);
		var command = args.Count > 0 ? args[0].ToLowerInvariant() : "status";
		if (args.Count > 0) args.RemoveAt(0);
		var flags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
		string rootArgument = null;
		string exeArgument = null;
		var positional = new List<string>();
		for (var index = 0; index < args.Count; index++)
		{
			var token = args[index];
			if (token == "--root" && index + 1 < args.Count) { rootArgument = args[++index]; continue; }
			if (token == "--exe" && index + 1 < args.Count) { exeArgument = args[++index]; continue; }
			if (token.StartsWith("--", StringComparison.Ordinal)) { flags.Add(token); continue; }
			positional.Add(token);
		}

		exePath = exeArgument ?? Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "shell", "app", "DeepSeek Harness桌面版.exe"));
		rootPath = rootArgument ?? Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
		statePath = Path.Combine(rootPath, "logs", "typing-mode.json");

		try
		{
			switch (command)
			{
				case "status": return Emit(StatusJson("status"), true);
				case "promote": return Promote(flags.Contains("--keep-below"), flags.Contains("--force"), !flags.Contains("--no-mask"), true);
				case "detach": return Promote(false, true, false, false);
				case "demote": return Demote(!flags.Contains("--no-mask"));
				case "mask-test": return MaskTest();
				case "focus": return FocusOnly();
				case "focus-window": return FocusWindow(positional.Count > 0 ? positional[0] : "");
				case "merge-test": return MergeTest(positional.Count > 0 ? string.Join(" ", positional) : "zz");
				case "focus-desktop": return FocusDesktop();
				case "send-text": return SendText(positional.Count > 0 ? string.Join(" ", positional) : "");
				default:
					return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_UNKNOWN_COMMAND\"}", false);
			}
		}
		catch (Exception error)
		{
			return Emit("{\"ok\":false,\"error\":" + Json(error.Message) + "}", false);
		}
	}

	// --------------------------------------------------------------- commands --
	private static int Promote(bool keepBelow, bool force, bool maskEnabled, bool grabKeyboard)
	{
		// C# 5 syntax only: this is compiled by the in-box .NET Framework 4
		// compiler (no SDK/Roslyn on this machine), so no tuples, no `out var`.
		string role;
		string parentClass;
		var target = FindShellWindow(out role, out parentClass);

		// Safety rail: only ever take the foreground when the desktop (or the
		// shell's own window) already owns it. A click on the desktop layer puts
		// the desktop in the foreground first, so this is what a real user click
		// looks like — and it means a stray trigger can never yank the keyboard
		// away from a game or any other foreground application. Skipped entirely
		// when this call is not taking the keyboard at all (`detach`).
		if (!force && grabKeyboard)
		{
			var foregroundClass = ClassName(GetForegroundWindow());
			var desktopOwnsForeground = GetForegroundWindow() == target
				|| foregroundClass == "Progman"
				|| foregroundClass == "WorkerW";
			if (!desktopOwnsForeground)
			{
				return Emit("{\"ok\":false,\"mode\":\"desktop\",\"error\":\"DSH_INPUT_FOREGROUND_NOT_DESKTOP\",\"foregroundClass\":"
					+ Json(foregroundClass) + ",\"windowId\":" + Handle(target) + "}", false);
			}
		}

		if (target == IntPtr.Zero) return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_SHELL_WINDOW_NOT_FOUND\"}", false);

		// Remember who owned the foreground before we took it.
		//
		// Leaving the desktop layer hands the keyboard to the desktop, which is not
		// where the user was: a promote triggered by a click in the layer displaces
		// whatever window had focus, and demote is a separate process invocation, so
		// the answer has to be persisted. Restoring it on demote is what makes
		// "click the desktop, type, click away" leave the user where they started.
		var displaced = grabKeyboard ? GetForegroundWindow() : IntPtr.Zero;
		if (displaced == target) displaced = IntPtr.Zero;

		var monitor = MonitorBounds(target);
		var style = GetStyle(target);
		// A previous run killed mid-transition could have left redraw off.
		SetRedraw(target, true);
		var promoted = (style & ~(WS_CHILD | WS_CAPTION | WS_THICKFRAME | WS_DLGFRAME | WS_BORDER)) | WS_POPUP | WS_VISIBLE;
		// Same rectangle as the attached layer occupies (the desktop view's client
		// origin is 0,0), so nothing moves or resizes — only the window's type
		// changes, and no client area needs repainting.
		//
		// Changing a window's composition identity (its own surface <-> a child
		// drawn into the desktop's surface) leaves one or two frames where neither
		// is showing, and no amount of in-window double buffering helps: the fix is
		// to hold the last frame over the swap until the new identity is live.
		var mask = IntPtr.Zero;
		IntPtr maskDc = IntPtr.Zero;
		IntPtr maskBitmap = IntPtr.Zero;
		IntPtr maskOldBitmap = IntPtr.Zero;
		if (maskEnabled)
		{
			mask = CreateFreezeMask(target, monitor.Left, monitor.Top, monitor.Right - monitor.Left, monitor.Bottom - monitor.Top, out maskDc, out maskBitmap, out maskOldBitmap);
		}
		SetRedraw(target, false);
		try
		{
			SetParent(target, IntPtr.Zero);
			SetStyle(target, promoted);
			SetWindowPos(target, HWND_TOP, monitor.Left, monitor.Top, monitor.Right - monitor.Left, monitor.Bottom - monitor.Top, SWP_NOACTIVATE);
		}
		finally
		{
			SetRedraw(target, true);
		}

		FocusResult focus;
		if (grabKeyboard)
		{
			focus = GrabKeyboard(target);
			if (keepBelow) PushBelowAllWindows(target);
		}
		else
		{
			focus.FocusIsShell = false;
			focus.Foreground = false;
		}
		ReleaseFreezeMask(mask, maskDc, maskBitmap, maskOldBitmap);

		// Without the keyboard, success means "no longer a child of the desktop".
		var focused = grabKeyboard ? IsKeyboardTarget(target) : GetParent(target) == IntPtr.Zero;
		var payload = new StringBuilder();
		payload.Append("{\"ok\":").Append(focused ? "true" : "false");
		payload.Append(",\"mode\":\"promoted\"");
		payload.Append(",\"windowId\":").Append(Handle(target));
		payload.Append(",\"wasRole\":").Append(Json(role ?? ""));
		payload.Append(",\"wasParentClass\":").Append(Json(parentClass ?? ""));
		payload.Append(",\"focusRequested\":").Append(grabKeyboard ? "true" : "false");
		payload.Append(",\"foreground\":").Append(focused ? "true" : "false");
		payload.Append(",\"focusWindowIsShell\":").Append(focus.FocusIsShell ? "true" : "false");
		payload.Append(",\"monitor\":").Append(RectJson(monitor));
		payload.Append(",\"styleBefore\":").Append(Json(Hex(style)));
		payload.Append(",\"styleAfter\":").Append(Json(Hex(GetStyle(target))));
		payload.Append(",\"keepBelow\":").Append(keepBelow ? "true" : "false");
		payload.Append(",\"displaced\":").Append(Handle(displaced));
		payload.Append(",\"displacedClass\":").Append(Json(displaced != IntPtr.Zero ? ClassName(displaced) : ""));
		payload.Append(",\"mask\":").Append(mask != IntPtr.Zero ? "true" : "false");
		payload.Append(",\"error\":").Append(Json(focused ? "" : "DSH_INPUT_FOCUS_FAILED"));
		payload.Append("}");
		WriteState(payload.ToString());
		return Emit(payload.ToString(), focused);
	}

	private static int Demote(bool maskEnabled)
	{
		IntPtr host;
		var defView = FindDefView(out host);
		if (defView == IntPtr.Zero) return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_DESKTOP_VIEW_NOT_FOUND\"}", false);
		string ignoredRole;
		string ignoredParent;
		var target = FindShellWindow(out ignoredRole, out ignoredParent);
		if (target == IntPtr.Zero) return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_SHELL_WINDOW_NOT_FOUND\"}", false);

		var size = ClientSize(defView);
		var style = GetStyle(target);
		var child = (style & ~WS_POPUP) | WS_CHILD | WS_VISIBLE;
		// A previous run killed mid-transition could have left redraw off.
		SetRedraw(target, true);
		var windowRect = WindowRect(target);
		var mask = IntPtr.Zero;
		IntPtr maskDc = IntPtr.Zero;
		IntPtr maskBitmap = IntPtr.Zero;
		IntPtr maskOldBitmap = IntPtr.Zero;
		if (maskEnabled)
		{
			mask = CreateFreezeMask(target, windowRect.Left, windowRect.Top, windowRect.Right - windowRect.Left, windowRect.Bottom - windowRect.Top, out maskDc, out maskBitmap, out maskOldBitmap);
		}
		SetRedraw(target, false);
		try
		{
			SetParent(target, defView);
			SetStyle(target, child);
			SetWindowPos(target, IntPtr.Zero, 0, 0, size.Right - size.Left, size.Bottom - size.Top, SWP_NOZORDER | SWP_NOACTIVATE);
		}
		finally
		{
			SetRedraw(target, true);
		}
		ReleaseFreezeMask(mask, maskDc, maskBitmap, maskOldBitmap);

		// A child of the desktop view can never own the foreground. Prefer handing it
		// back to whoever had it before the promote (the window the user was actually
		// in); fall back to the desktop so the next click behaves like a normal
		// desktop click.
		var handed = false;
		var restoredTo = "";
		var hadForeground = GetForegroundWindow() == target;
		if (hadForeground)
		{
			var displaced = ParseHandle(FieldOf(ReadState(), "displaced"));
			if (displaced != IntPtr.Zero && displaced != target && IsWindow(displaced))
			{
				GrabKeyboard(displaced);
				if (GetForegroundWindow() == displaced)
				{
					handed = true;
					restoredTo = ClassName(displaced);
				}
			}
			if (!handed)
			{
				var hostWindow = host != IntPtr.Zero ? host : GetDesktopWindow();
				uint ignoredPid;
				var foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignoredPid);
				var me = GetCurrentThreadId();
				var attached = foregroundThread != 0 && foregroundThread != me && AttachThreadInput(me, foregroundThread, true);
				try { handed = SetForegroundWindow(hostWindow); }
				finally { if (attached) AttachThreadInput(me, foregroundThread, false); }
				if (handed) restoredTo = ClassName(hostWindow);
			}
		}

		var attachedBack = GetParent(target) == defView;
		var after = ClientSize(target);
		var payload = new StringBuilder();
		payload.Append("{\"ok\":").Append(attachedBack ? "true" : "false");
		payload.Append(",\"mode\":\"desktop\"");
		payload.Append(",\"windowId\":").Append(Handle(target));
		payload.Append(",\"parentClass\":").Append(Json(ClassName(GetParent(target))));
		payload.Append(",\"clientSize\":").Append(Json((after.Right - after.Left) + "x" + (after.Bottom - after.Top)));
		payload.Append(",\"expectedSize\":").Append(Json((size.Right - size.Left) + "x" + (size.Bottom - size.Top)));
		payload.Append(",\"foregroundHandedBack\":").Append(handed ? "true" : "false");
		payload.Append(",\"restoredTo\":").Append(Json(restoredTo));
		payload.Append(",\"mask\":").Append(mask != IntPtr.Zero ? "true" : "false");
		payload.Append(",\"error\":").Append(Json(attachedBack ? "" : "DSH_INPUT_DEMOTE_FAILED"));
		payload.Append("}");
		WriteState(payload.ToString());
		return Emit(payload.ToString(), attachedBack);
	}

	private static int FocusOnly()
	{
		string ignoredRole;
		string parentClass;
		var target = FindShellWindow(out ignoredRole, out parentClass);
		if (target == IntPtr.Zero) return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_SHELL_WINDOW_NOT_FOUND\"}", false);
		if (parentClass == "SHELLDLL_DefView")
			return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_STILL_ON_DESKTOP_LAYER\"}", false);
		var focus = GrabKeyboard(target);
		var focused = IsKeyboardTarget(target);
		return Emit("{\"ok\":" + (focused ? "true" : "false") + ",\"foreground\":" + (focused ? "true" : "false")
			+ ",\"focusWindowIsShell\":" + (focus.FocusIsShell ? "true" : "false")
			+ ",\"error\":" + Json(focused ? "" : "DSH_INPUT_FOCUS_FAILED") + "}", focused);
	}

	/// Give the foreground to the desktop itself, which is the state a click on
	/// the desktop produces. Used to test the real "click the layer and type"
	/// path without synthesizing a mouse click at guessed screen coordinates.
	private static int FocusDesktop()
	{
		var progman = FindWindowEx(IntPtr.Zero, IntPtr.Zero, "Progman", null);
		if (progman == IntPtr.Zero)
		{
			IntPtr host;
			FindDefView(out host);
			progman = host;
		}
		if (progman == IntPtr.Zero) return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_DESKTOP_WINDOW_NOT_FOUND\"}", false);
		GrabKeyboard(progman);
		var foreground = GetForegroundWindow();
		var ok = foreground == progman;
		return Emit("{\"ok\":" + (ok ? "true" : "false") + ",\"foreground\":" + (ok ? "true" : "false")
			+ ",\"foregroundClass\":" + Json(ClassName(foreground))
			+ ",\"desktopWindowId\":" + Handle(progman)
			+ ",\"error\":" + Json(ok ? "" : "DSH_INPUT_DESKTOP_FOCUS_FAILED") + "}", ok);
	}

	/// Give an arbitrary window the foreground (used to put things back exactly
	/// as they were after a test). Same queue-merge requirement as everything else.
	private static int FocusWindow(string handle)
	{
		var hwnd = ParseHandle(handle);
		if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_WINDOW_NOT_FOUND\"}", false);
		GrabKeyboard(hwnd);
		var ok = GetForegroundWindow() == hwnd;
		return Emit("{\"ok\":" + (ok ? "true" : "false") + ",\"foregroundClass\":" + Json(ClassName(hwnd))
			+ ",\"error\":" + Json(ok ? "" : "DSH_INPUT_WINDOW_FOCUS_FAILED") + "}", ok);
	}

	/// Test-only: the decisive experiment for "never leave the desktop layer".
	///
	/// A WS_CHILD of Explorer's desktop view can never *be* the foreground window,
	/// but it can still receive keystrokes: keyboard input is dispatched inside the
	/// foreground thread's input queue, so if the shell's thread shares that queue
	/// (AttachThreadInput) and its focus window is ours, keys land on the child.
	/// This proves the path end to end by injecting real characters and letting the
	/// caller read the page to see whether they arrived.
	private static int MergeTest(string text)
	{
		string role;
		string parentClass;
		var target = FindShellWindow(out role, out parentClass);
		if (target == IntPtr.Zero) return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_SHELL_WINDOW_NOT_FOUND\"}", false);

		// The desktop must own the foreground at the instant the keys are injected
		// (a click on the desktop layer does exactly that), otherwise the queue we
		// merge with belongs to whatever else is in front.
		var progman = FindWindowEx(IntPtr.Zero, IntPtr.Zero, "Progman", null);
		if (progman != IntPtr.Zero) GrabKeyboard(progman);

		uint ignoredPid;
		var me = GetCurrentThreadId();
		var targetThread = GetWindowThreadProcessId(target, out ignoredPid);
		var foreground = GetForegroundWindow();
		var foregroundThread = GetWindowThreadProcessId(foreground, out ignoredPid);
		var attachedTarget = targetThread != 0 && targetThread != me && AttachThreadInput(me, targetThread, true);
		var attachedForeground = foregroundThread != 0 && foregroundThread != me && foregroundThread != targetThread
			&& AttachThreadInput(me, foregroundThread, true);

		var focusWindow = IntPtr.Zero;
		var focusIsTarget = false;
		var sent = 0u;
		try
		{
			SetFocus(target);
			var info = new GUITHREADINFO();
			info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
			if (GetGUIThreadInfo(targetThread, ref info))
			{
				focusWindow = info.hwndFocus;
				focusIsTarget = focusWindow == target;
			}
			if (!string.IsNullOrEmpty(text))
			{
				var inputs = new List<INPUT>();
				foreach (var character in text)
				{
					inputs.Add(UnicodeKey(character, false));
					inputs.Add(UnicodeKey(character, true));
				}
				sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
			}
		}
		finally
		{
			if (attachedForeground) AttachThreadInput(me, foregroundThread, false);
			if (attachedTarget) AttachThreadInput(me, targetThread, false);
		}

		var payload = new StringBuilder();
		payload.Append("{\"ok\":").Append(focusIsTarget ? "true" : "false");
		payload.Append(",\"windowId\":").Append(Handle(target));
		payload.Append(",\"parentClass\":").Append(Json(parentClass ?? ""));
		payload.Append(",\"foregroundClass\":").Append(Json(ClassName(GetForegroundWindow())));
		payload.Append(",\"foregroundIsDesktop\":").Append(GetForegroundWindow() == progman ? "true" : "false");
		payload.Append(",\"focusIsShellWindow\":").Append(focusIsTarget ? "true" : "false");
		payload.Append(",\"focusWindowClass\":").Append(Json(ClassName(focusWindow)));
		payload.Append(",\"sent\":").Append(sent);
		payload.Append(",\"text\":").Append(Json(text));
		payload.Append(",\"error\":").Append(Json(focusIsTarget ? "" : "DSH_INPUT_MERGE_FOCUS_FAILED"));
		payload.Append("}");
		return Emit(payload.ToString(), focusIsTarget);
	}

	private static IntPtr ParseHandle(string text)
	{
		if (string.IsNullOrEmpty(text)) return IntPtr.Zero;
		var value = text.Trim();
		if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) value = value.Substring(2);
		long parsed;
		if (!long.TryParse(value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out parsed)) return IntPtr.Zero;
		return new IntPtr(parsed);
	}

	/// Test-only: type literal text into whichever window currently owns the
	/// keyboard, and only when that window belongs to the shell (so synthetic
	/// keystrokes can never land in an unrelated application).
	private static int SendText(string text)
	{
		string ignoredRole;
		string ignoredParent;
		var target = FindShellWindow(out ignoredRole, out ignoredParent);
		if (target == IntPtr.Zero) return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_SHELL_WINDOW_NOT_FOUND\"}", false);
		uint ignoredPid;
		var owner = GetWindowThreadProcessId(GetForegroundWindow(), out ignoredPid);
		var shellThread = GetWindowThreadProcessId(target, out ignoredPid);
		if (GetForegroundWindow() != target && owner != shellThread)
			return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_NOT_FOREGROUND\"}", false);
		if (string.IsNullOrEmpty(text)) return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_TEXT_REQUIRED\"}", false);

		var inputs = new List<INPUT>();
		foreach (var character in text)
		{
			inputs.Add(UnicodeKey(character, false));
			inputs.Add(UnicodeKey(character, true));
		}
		var sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
		var ok = sent == inputs.Count;
		return Emit("{\"ok\":" + (ok ? "true" : "false") + ",\"sent\":" + sent + ",\"length\":" + inputs.Count
			+ ",\"error\":" + Json(ok ? "" : "DSH_INPUT_SEND_FAILED") + "}", ok);
	}

	private static INPUT UnicodeKey(char character, bool keyUp)
	{
		return new INPUT
		{
			type = 1, // INPUT_KEYBOARD
			ki = new KEYBDINPUT
			{
				wVk = 0,
				wScan = character,
				dwFlags = 0x0004 | (keyUp ? 0x0002u : 0u) // KEYEVENTF_UNICODE (+KEYEVENTF_KEYUP)
			}
		};
	}

	/// Suppress repaints across a reparent/style change: without this the desktop
	/// flashes for a frame while the renderer catches up. The window has no
	/// non-client frame at all, so there is nothing to recalculate and
	/// SWP_FRAMECHANGED (which forces exactly that repaint) is not used.
	///
	/// Callers must pair this with SetRedraw(window, true); every command also
	/// re-enables redraw on entry, so a helper killed mid-transition cannot leave
	/// the window frozen.
	private static void SetRedraw(IntPtr window, bool enabled)
	{
		if (window == IntPtr.Zero) return;
		SendMessage(window, WM_SETREDRAW, new IntPtr(enabled ? 1 : 0), IntPtr.Zero);
		if (enabled) RedrawWindow(window, IntPtr.Zero, IntPtr.Zero, RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
	}

	// ------------------------------------------------------------ freeze mask --
	/// <summary>
	/// Copy the window's current pixels and hold them over the upcoming swap.
	///
	/// This is the only form of double buffering that applies here. The flash is
	/// not our window painting badly — it is the frame in which the window is
	/// neither "its own composited surface" nor "a child drawn into the desktop's
	/// surface". Measured: a WS_CHILD of the desktop can never be the active
	/// window, so Chromium refuses the keystrokes even when its thread shares the
	/// foreground queue and its focus window is set (focusIsShellWindow true, four
	/// real keys injected, the page received none) — the window *must* leave the
	/// layer to type, so the swap must be hidden instead.
	///
	/// The mask is a layered, click-through, non-activating window carrying the
	/// last frame, placed just above the desktop and below every application, so it
	/// can never cover other work. It lives inside this short-lived process: if the
	/// process dies the mask dies with it, and a failed capture simply means no
	/// mask rather than a wrong one.
	/// </summary>
	private static IntPtr CreateFreezeMask(IntPtr target, int x, int y, int width, int height, out IntPtr memoryDc, out IntPtr bitmap, out IntPtr oldBitmap)
	{
		memoryDc = IntPtr.Zero;
		bitmap = IntPtr.Zero;
		oldBitmap = IntPtr.Zero;
		if (target == IntPtr.Zero || width <= 0 || height <= 0) return IntPtr.Zero;
		var screenDc = GetDC(IntPtr.Zero);
		if (screenDc == IntPtr.Zero) return IntPtr.Zero;
		try
		{
			memoryDc = CreateCompatibleDC(screenDc);
			if (memoryDc == IntPtr.Zero) return IntPtr.Zero;
			var info = new BITMAPINFO();
			info.bmiHeader.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
			info.bmiHeader.biWidth = width;
			info.bmiHeader.biHeight = -height;
			info.bmiHeader.biPlanes = 1;
			info.bmiHeader.biBitCount = 32;
			info.bmiHeader.biCompression = 0;
			IntPtr bits;
			bitmap = CreateDIBSection(screenDc, ref info, 0, out bits, IntPtr.Zero, 0);
			if (bitmap == IntPtr.Zero) return IntPtr.Zero;
			oldBitmap = SelectObject(memoryDc, bitmap);
			// PW_RENDERFULLCONTENT: ask DWM for the composited content, which is the
			// only capture that is correct for a Chromium window.
			if (!PrintWindow(target, memoryDc, 2)) return IntPtr.Zero;

			const int WS_EX_LAYERED = 0x00080000;
			const int WS_EX_TRANSPARENT = 0x00000020;
			const int WS_EX_TOOLWINDOW = 0x00000080;
			const int WS_EX_NOACTIVATE = 0x08000000;
			const int WS_POPUP_STYLE = unchecked((int)0x80000000);
			var overlay = CreateWindowEx(
				WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
				"Static", null, WS_POPUP_STYLE, x, y, width, height,
				IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
			if (overlay == IntPtr.Zero) return IntPtr.Zero;

			var destination = new POINT();
			destination.X = x;
			destination.Y = y;
			var size = new SIZE();
			size.cx = width;
			size.cy = height;
			var source = new POINT();
			var blend = new BLENDFUNCTION();
			blend.BlendOp = 0;
			blend.SourceConstantAlpha = 255;
			blend.AlphaFormat = 0;
			// ULW_ALPHA (2): the pixels are set in the same call that makes the
			// window visible, so the overlay never shows a first-paint flash of its
			// own.
			if (!UpdateLayeredWindow(overlay, screenDc, ref destination, ref size, memoryDc, ref source, 0, ref blend, 2))
			{
				DestroyWindow(overlay);
				return IntPtr.Zero;
			}
			SetWindowPos(overlay, HWND_BOTTOM, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
			return overlay;
		}
		finally
		{
			ReleaseDC(IntPtr.Zero, screenDc);
		}
	}

	/// Hold the mask long enough for the new composition identity to be live, then
	/// drop it. The frozen frame is shown for ~160ms, which is imperceptible on a
	/// still wallpaper and a brief freeze on a video one — both far better than a
	/// flash of the wallpaper underneath.
	private static void ReleaseFreezeMask(IntPtr overlay, IntPtr memoryDc, IntPtr bitmap, IntPtr oldBitmap)
	{
		if (overlay == IntPtr.Zero) return;
		Thread.Sleep(160);
		DestroyWindow(overlay);
		if (memoryDc != IntPtr.Zero && oldBitmap != IntPtr.Zero) SelectObject(memoryDc, oldBitmap);
		if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
		if (memoryDc != IntPtr.Zero) DeleteDC(memoryDc);
	}

	/// Diagnostic: build a mask over the current layer, report where it landed in
	/// the z order, then remove it. Verifies the placement without needing a real
	/// transition and without touching the foreground.
	private static int MaskTest()
	{
		string role;
		string parentClass;
		var target = FindShellWindow(out role, out parentClass);
		if (target == IntPtr.Zero) return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_SHELL_WINDOW_NOT_FOUND\"}", false);
		var rect = WindowRect(target);
		var width = rect.Right - rect.Left;
		var height = rect.Bottom - rect.Top;
		IntPtr memoryDc;
		IntPtr bitmap;
		IntPtr oldBitmap;
		var overlay = CreateFreezeMask(target, rect.Left, rect.Top, width, height, out memoryDc, out bitmap, out oldBitmap);
		if (overlay == IntPtr.Zero) return Emit("{\"ok\":false,\"error\":\"DSH_INPUT_MASK_FAILED\"}", false);
		var below = GetWindow(overlay, 2);
		var above = GetWindow(overlay, 3);
		var chain = new StringBuilder();
		var cursor = overlay;
		for (var index = 0; index < 5; index++)
		{
			cursor = GetWindow(cursor, 2);
			if (cursor == IntPtr.Zero) break;
			chain.Append(ClassName(cursor)).Append(' ');
		}
		var payload = "{\"ok\":true,\"maskWindowId\":" + Handle(overlay)
			+ ",\"aboveMask\":" + Json(ClassName(above))
			+ ",\"belowMask\":" + Json(ClassName(below))
			+ ",\"chainBelow\":" + Json(chain.ToString().Trim())
			+ ",\"rect\":" + RectJson(rect) + "}";
		ReleaseFreezeMask(overlay, memoryDc, bitmap, oldBitmap);
		return Emit(payload, true);
	}

	// ------------------------------------------------------------------ focus --
	/// Merge input queues with the foreground thread and the window's own thread
	/// before asking for the foreground: Windows refuses SetForegroundWindow to a
	/// process that is neither foreground nor the owner of the last input event,
	/// and queue merging is the documented way around that.
	private struct FocusResult
	{
		public bool FocusIsShell;
		public bool Foreground;
	}

	private static FocusResult GrabKeyboard(IntPtr target)
	{
		var me = GetCurrentThreadId();
		uint ignoredPid;
		var targetThread = GetWindowThreadProcessId(target, out ignoredPid);
		var foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignoredPid);

		var attachedTarget = targetThread != 0 && targetThread != me && AttachThreadInput(me, targetThread, true);
		var attachedForeground = foregroundThread != 0 && foregroundThread != me && foregroundThread != targetThread
			&& AttachThreadInput(me, foregroundThread, true);
		try
		{
			BringWindowToTop(target);
			SetForegroundWindow(target);
			SetActiveWindow(target);
			SetFocus(target);
		}
		finally
		{
			if (attachedForeground) AttachThreadInput(me, foregroundThread, false);
			if (attachedTarget) AttachThreadInput(me, targetThread, false);
		}
		FocusResult result;
		result.FocusIsShell = targetThread != 0;
		result.Foreground = GetForegroundWindow() == target;
		return result;
	}

	/// True when the shell's thread would actually receive keyboard input: its
	/// focus window is the shell window (or a child of it) and it is foreground.
	private static bool IsKeyboardTarget(IntPtr target)
	{
		if (GetForegroundWindow() != target) return false;
		uint ignoredPid;
		var thread = GetWindowThreadProcessId(target, out ignoredPid);
		var info = new GUITHREADINFO();
		info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
		if (!GetGUIThreadInfo(thread, ref info)) return false;
		if (info.hwndFocus == IntPtr.Zero) return false;
		if (info.hwndFocus == target) return true;
		return GetParent(info.hwndFocus) == target;
	}

	/// Keep the promoted window active but out of the way: the desktop normally
	/// sits behind every window, so a promoted layer that covers the screen would
	/// be a visible regression. Activation and z-order are independent, so the
	/// window keeps the keyboard while moving to the bottom of the stack.
	private static void PushBelowAllWindows(IntPtr target)
	{
		SetWindowPos(target, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
	}

	// -------------------------------------------------------------- discovery --
	private static IntPtr FindShellWindow(out string role, out string parentClass)
	{
		role = null;
		parentClass = null;
		var candidates = new List<KeyValuePair<long, IntPtr>>();
		var seen = new HashSet<long>();

		EnumWindows((window, _) =>
		{
			Consider(window, "top-level", candidates, seen);
			return true;
		}, IntPtr.Zero);

		IntPtr ignoredHost;
		var defView = FindDefView(out ignoredHost);
		if (defView != IntPtr.Zero)
		{
			EnumChildWindows(defView, (window, _) =>
			{
				var className = ClassName(window);
				if (className == "Chrome_RenderWidgetHostHWND")
				{
					var parent = GetParent(window);
					if (parent != IntPtr.Zero) Consider(parent, "child-content", candidates, seen);
				}
				else
				{
					Consider(window, "child", candidates, seen);
				}
				return true;
			}, IntPtr.Zero);
		}

		var best = IntPtr.Zero;
		var bestArea = -1L;
		foreach (var candidate in candidates)
		{
			if (candidate.Key <= bestArea) continue;
			bestArea = candidate.Key;
			best = candidate.Value;
		}
		if (best == IntPtr.Zero) return IntPtr.Zero;
		parentClass = ClassName(GetParent(best));
		role = parentClass == "SHELLDLL_DefView" ? "desktop-child" : "top-level";
		return best;
	}

	private static void Consider(IntPtr window, string role, List<KeyValuePair<long, IntPtr>> candidates, HashSet<long> seen)
	{
		if (window == IntPtr.Zero) return;
		if (ClassName(window) != "Chrome_WidgetWin_1") return;
		var key = window.ToInt64();
		if (!seen.Add(key)) return;
		if (!IsShellProcess(window)) return;
		var rect = WindowRect(window);
		var width = rect.Right - rect.Left;
		var height = rect.Bottom - rect.Top;
		if (width < 200 || height < 200) return;
		// While the layer is welded to the desktop it is the DefView child;
		// that one always wins, because the shell may legitimately own other
		// full-size windows (a wallpaper window) that must never be reparented.
		var weight = role.StartsWith("child", StringComparison.Ordinal) ? 1000000000000L : 0L;
		candidates.Add(new KeyValuePair<long, IntPtr>(weight + (long)width * height, window));
	}

	private static bool IsShellProcess(IntPtr window)
	{
		try
		{
			uint processId;
			GetWindowThreadProcessId(window, out processId);
			if (processId == 0) return false;
			using (var process = Process.GetProcessById((int)processId))
			{
				try { return string.Equals(Path.GetFullPath(process.MainModule.FileName), exePath, StringComparison.OrdinalIgnoreCase); }
				catch { return false; }
			}		}
		catch { return false; }
	}

	private static IntPtr FindDefView(out IntPtr host)
	{
		var defView = IntPtr.Zero;
		var owner = IntPtr.Zero;
		EnumWindows((window, _) =>
		{
			var view = FindWindowEx(window, IntPtr.Zero, "SHELLDLL_DefView", null);
			if (view == IntPtr.Zero) return true;
			defView = view;
			owner = window;
			return false;
		}, IntPtr.Zero);
		host = owner;
		return defView;
	}

	// ------------------------------------------------------------------ status --
	private static string StatusJson(string reason)
	{
		string role;
		string parentClass;
		IntPtr host;
		var target = FindShellWindow(out role, out parentClass);
		var defView = FindDefView(out host);
		var foreground = GetForegroundWindow();
		var keyboard = target != IntPtr.Zero && IsKeyboardTarget(target);
		var payload = new StringBuilder();
		payload.Append("{\"ok\":").Append(target != IntPtr.Zero ? "true" : "false");
		payload.Append(",\"reason\":").Append(Json(reason));
		payload.Append(",\"windowId\":").Append(Handle(target));
		payload.Append(",\"role\":").Append(Json(role ?? ""));
		payload.Append(",\"parentClass\":").Append(Json(parentClass ?? ""));
		payload.Append(",\"onDesktopLayer\":").Append(parentClass == "SHELLDLL_DefView" ? "true" : "false");
		payload.Append(",\"keyboard\":").Append(keyboard ? "true" : "false");
		payload.Append(",\"foregroundIsShell\":").Append(foreground == target ? "true" : "false");
		payload.Append(",\"foregroundClass\":").Append(Json(ClassName(foreground)));
		payload.Append(",\"style\":").Append(Json(Hex(GetStyle(target))));
		payload.Append(",\"windowRect\":").Append(RectJson(WindowRect(target)));
		payload.Append(",\"clientSize\":").Append(Json(SizeText(ClientSize(target))));
		payload.Append(",\"desktopViewId\":").Append(Handle(defView));
		payload.Append(",\"desktopHostId\":").Append(Handle(host));
		payload.Append(",\"desktopViewClient\":").Append(Json(defView != IntPtr.Zero ? SizeText(ClientSize(defView)) : ""));
		payload.Append(",\"monitor\":").Append(RectJson(target != IntPtr.Zero ? MonitorBounds(target) : default(RECT)));
		payload.Append(",\"state\":").Append(Json(ReadState()));
		payload.Append(",\"error\":").Append(Json(target != IntPtr.Zero ? "" : "DSH_INPUT_SHELL_WINDOW_NOT_FOUND"));
		payload.Append("}");
		return payload.ToString();
	}

	// ------------------------------------------------------------------ helpers --
	private static RECT WindowRect(IntPtr window)
	{
		RECT rect;
		if (window == IntPtr.Zero || !GetWindowRect(window, out rect)) return default(RECT);
		return rect;
	}

	private static RECT ClientSize(IntPtr window)
	{
		RECT rect;
		if (window == IntPtr.Zero || !GetClientRect(window, out rect)) return default(RECT);
		return rect;
	}

	private static RECT MonitorBounds(IntPtr window)
	{
		var monitor = MonitorFromWindow(window, 2 /* MONITOR_DEFAULTTONEAREST */);
		var info = new MONITORINFO();
		info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
		if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return WindowRect(window);
		return info.rcMonitor;
	}

	private static long GetStyle(IntPtr window)
	{
		if (window == IntPtr.Zero) return 0;
		return (IntPtr.Size == 8 ? GetWindowLongPtr64(window, GWL_STYLE) : GetWindowLong32(window, GWL_STYLE)).ToInt64();
	}

	private static void SetStyle(IntPtr window, long style)
	{
		if (IntPtr.Size == 8) SetWindowLongPtr64(window, GWL_STYLE, new IntPtr(style));
		else SetWindowLong32(window, GWL_STYLE, new IntPtr(style));
	}

	private static string ClassName(IntPtr window)
	{
		if (window == IntPtr.Zero) return "";
		var value = new StringBuilder(256);
		GetClassName(window, value, value.Capacity);
		return value.ToString();
	}

	private static string SizeText(RECT rect)
	{
		return (rect.Right - rect.Left) + "x" + (rect.Bottom - rect.Top);
	}

	private static string Hex(long value)
	{
		return "0x" + value.ToString("X8", CultureInfo.InvariantCulture);
	}

	private static string Handle(IntPtr window)
	{
		return window == IntPtr.Zero ? "\"\"" : "\"0x" + window.ToInt64().ToString("X8", CultureInfo.InvariantCulture) + "\"";
	}

	private static string RectJson(RECT rect)
	{
		return "{\"x\":" + rect.Left + ",\"y\":" + rect.Top + ",\"width\":" + (rect.Right - rect.Left) + ",\"height\":" + (rect.Bottom - rect.Top) + "}";
	}

	private static string Json(string value)
	{
		if (value == null) return "null";
		var text = new StringBuilder("\"");
		foreach (var character in value)
		{
			switch (character)
			{
				case '"': text.Append("\\\""); break;
				case '\\': text.Append("\\\\"); break;
				case '\n': text.Append("\\n"); break;
				case '\r': text.Append("\\r"); break;
				case '\t': text.Append("\\t"); break;
				default:
					if (character < 0x20) text.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
					else text.Append(character);
					break;
			}
		}
		return text.Append('"').ToString();
	}

	private static void WriteState(string json)
	{
		try
		{
			Directory.CreateDirectory(Path.GetDirectoryName(statePath));
			File.WriteAllText(statePath, json + Environment.NewLine, new UTF8Encoding(false));
		}
		catch { /* state is diagnostic only */ }
	}

	private static string ReadState()
	{
		try
		{
			if (!File.Exists(statePath)) return "";
			return File.ReadAllText(statePath).Trim();
		}
		catch { return ""; }
	}

	/// Read one quoted string field out of the state document.
	///
	/// The state file is a single line this tool writes itself, so a tiny scan is
	/// enough and keeps the helper free of a JSON dependency (it is compiled by the
	/// in-box csc against .NET Framework).
	private static string FieldOf(string json, string name)
	{
		if (string.IsNullOrEmpty(json)) return "";
		var key = "\"" + name + "\":\"";
		var start = json.IndexOf(key, StringComparison.Ordinal);
		if (start < 0) return "";
		start += key.Length;
		var end = json.IndexOf('"', start);
		return end < 0 ? "" : json.Substring(start, end - start);
	}

	private static int Emit(string json, bool ok)
	{
		Console.Out.Write(json);
		Console.Out.Write("\n");
		Console.Out.Flush();
		return ok ? 0 : 1;
	}
}
