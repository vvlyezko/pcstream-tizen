// winlist.exe — список окон для выбора источника (вместо desktopCapturer, который течёт памятью).
// Выводит JSON-массив: [{"hwnd":..,"pid":..,"title":"..","exe":"..","min":false,"w":..,"h":..}]
// Сборка: csc /nologo /optimize /target:exe /out:..\bin\winlist.exe winlist.cs
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

static class WinList
{
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder s, int max);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }

    const int GWL_EXSTYLE = -20;
    const long WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000, WS_EX_NOACTIVATE = 0x8000000;
    const uint GW_OWNER = 4;
    const int DWMWA_CLOAKED = 14;

    static string Json(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static string ExePath(uint pid)
    {
        IntPtr h = OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid);
        if (h == IntPtr.Zero) return "";
        try
        {
            var sb = new StringBuilder(1024);
            int size = sb.Capacity;
            return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : "";
        }
        finally { CloseHandle(h); }
    }

    static int Main()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } // per-monitor v2: реальные пиксели
        Console.OutputEncoding = Encoding.UTF8;
        var items = new List<string>();
        EnumWindows(delegate (IntPtr hwnd, IntPtr lp)
        {
            if (!IsWindowVisible(hwnd)) return true;
            int len = GetWindowTextLength(hwnd);
            if (len == 0) return true;
            long ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
            bool tool = (ex & WS_EX_TOOLWINDOW) != 0 && (ex & WS_EX_APPWINDOW) == 0;
            if (tool || (ex & WS_EX_NOACTIVATE) != 0) return true;
            if (GetWindow(hwnd, GW_OWNER) != IntPtr.Zero && (ex & WS_EX_APPWINDOW) == 0) return true;
            int cloaked;
            if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
            var title = new StringBuilder(len + 1);
            GetWindowText(hwnd, title, title.Capacity);
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            RECT r;
            GetWindowRect(hwnd, out r);
            items.Add(string.Format("{{\"hwnd\":\"{0}\",\"pid\":{1},\"title\":{2},\"exe\":{3},\"min\":{4},\"w\":{5},\"h\":{6}}}",
                hwnd.ToInt64(), pid, Json(title.ToString()), Json(ExePath(pid)), IsIconic(hwnd) ? "true" : "false",
                r.Right - r.Left, r.Bottom - r.Top));
            return true;
        }, IntPtr.Zero);
        Console.Write("[" + string.Join(",", items.ToArray()) + "]");
        return 0;
    }
}
