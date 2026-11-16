using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("일검풍운결 세이브 에디터 v1.0")]
[assembly: AssemblyProduct("일검풍운결 세이브 에디터")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace WanderingSwordSaveEditor
{
    internal sealed class Program
    {
        private const string AppTitle = "일검풍운결 세이브 에디터 v1.0";
        private const string GameRunningMessage = "일검풍운결 게임이 실행 중입니다. 게임을 종료한 뒤 저장하세요.";

        public static Form MainForm;
        public static WebView2 Web;
        public static string RuntimeFolder;
        public static string TestRoot;
        public static string SeedSourceSav;
        public static bool TestRootOwned;

        private static string activePath;
        private static string activeHash;
        private static string activeSession;
        private static string lastFolder;
        public static int ExitCode;
        private static bool closingAllowed;
        private static bool selfTestStarted;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer
        {
            MaxJsonLength = 64 * 1024 * 1024,
            RecursionLimit = 32
        };

        [STAThread]
        private static int Main(string[] args)
        {
            if (args != null && args.Length >= 2 && String.Equals(args[0], "--self-test", StringComparison.Ordinal))
            {
                if (args.Length != 2 && args.Length != 3)
                {
                    Console.Error.WriteLine("사용법: WanderingSwordSaveEditor-v1.0.exe --self-test <테스트폴더> [<시드세이브>]");
                    return 2;
                }
                TestRoot = Path.GetFullPath(args[1]);
                if (Directory.Exists(TestRoot) || File.Exists(TestRoot))
                {
                    Console.Error.WriteLine("자체 점검 폴더가 이미 존재합니다: " + TestRoot);
                    return 2;
                }
                Directory.CreateDirectory(TestRoot);
                TestRootOwned = true;
                RuntimeFolder = TestRoot;
                if (args.Length == 3)
                {
                    SeedSourceSav = Path.GetFullPath(args[2]);
                }
            }
            else if (args != null && args.Length != 0)
            {
                Console.Error.WriteLine("사용법: WanderingSwordSaveEditor-v1.0.exe [--self-test <테스트폴더> [<시드세이브>]]");
                return 2;
            }
            else
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                RuntimeFolder = Path.Combine(localAppData, "WanderingSwordSaveEditor", "runtime-1.0.0");
            }

            AppDomain.CurrentDomain.AssemblyResolve += OnAssemblyResolve;

            try
            {
                Run();
            }
            catch (Exception ex)
            {
                Fail(ex);
                return ExitCode == 0 ? 1 : ExitCode;
            }

            return ExitCode;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void Run()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            Directory.CreateDirectory(RuntimeFolder);
            ExtractLoaderDll();

            CoreWebView2Environment.SetLoaderDllFolderPath(RuntimeFolder);

            MainForm = new Form();
            MainForm.Text = AppTitle;
            MainForm.Width = 1220;
            MainForm.Height = 840;
            MainForm.MinimumSize = new Size(900, 620);
            MainForm.StartPosition = FormStartPosition.CenterScreen;
            MainForm.FormClosing += OnFormClosing;

            if (TestRoot != null)
            {
                MainForm.WindowState = FormWindowState.Minimized;
                MainForm.ShowInTaskbar = false;
                MainForm.StartPosition = FormStartPosition.Manual;
                MainForm.Location = new Point(-32000, -32000);
                MainForm.Opacity = 0.0;
            }

            Web = new WebView2();
            Web.Dock = DockStyle.Fill;
            MainForm.Controls.Add(Web);
            MainForm.FormClosed += delegate { Web.Dispose(); };

            MainForm.Shown += async delegate
            {
                try
                {
                    await InitWebViewAsync();
                }
                catch (Exception ex)
                {
                    Fail(ex);
                }
            };

            Application.Run(MainForm);
        }

        private static void ExtractLoaderDll()
        {
            byte[] embedded = ReadResource("WebView2Loader.dll");
            if (embedded == null)
            {
                throw new InvalidOperationException("내장된 WebView2 런타임 로더를 찾을 수 없습니다.");
            }
            string expected = SaveStore.Hash(embedded);
            string destination = Path.Combine(RuntimeFolder, "WebView2Loader.dll");

            bool needWrite = true;
            if (File.Exists(destination))
            {
                try
                {
                    byte[] existing = File.ReadAllBytes(destination);
                    if (String.Equals(SaveStore.Hash(existing), expected, StringComparison.Ordinal))
                    {
                        needWrite = false;
                    }
                }
                catch (Exception)
                {
                    needWrite = true;
                }
            }

            if (needWrite)
            {
                if (File.Exists(destination))
                {
                    File.SetAttributes(destination, FileAttributes.Normal);
                    File.Delete(destination);
                }
                File.WriteAllBytes(destination, embedded);
            }

            byte[] check = File.ReadAllBytes(destination);
            if (!String.Equals(SaveStore.Hash(check), expected, StringComparison.Ordinal))
            {
                throw new IOException("WebView2 런타임 로더 무결성 검증에 실패했습니다.");
            }
        }

        private static void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!closingAllowed && TestRoot != null)
            {
                e.Cancel = true;
            }
        }

        private static async Task InitWebViewAsync()
        {
            string profileFolder = Path.Combine(RuntimeFolder, "Profile");
            SaveStore.NoLinks(profileFolder);
            CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions("--disable-background-networking");
            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profileFolder, options);
            await Web.EnsureCoreWebView2Async(environment);

            CoreWebView2Settings settings = Web.CoreWebView2.Settings;
            settings.AreDevToolsEnabled = false;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.IsGeneralAutofillEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsWebMessageEnabled = true;
            try
            {
                settings.AreHostObjectsAllowed = false;
            }
            catch (Exception)
            {
            }

            Web.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
            };
            Web.CoreWebView2.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e)
            {
                e.State = CoreWebView2PermissionState.Deny;
                e.Handled = true;
            };

            bool initialNavigationSeen = false;
            Web.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
            {
                string uri = e.Uri == null ? "" : e.Uri;
                if (!initialNavigationSeen && (uri.StartsWith("about:blank", StringComparison.OrdinalIgnoreCase)
                    || uri.StartsWith("data:text/html", StringComparison.OrdinalIgnoreCase)))
                {
                    initialNavigationSeen = true;
                    return;
                }
                e.Cancel = true;
            };

            Web.CoreWebView2.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            Web.CoreWebView2.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs e)
            {
                string uri = e.Request.Uri == null ? "" : e.Request.Uri;
                if (uri.StartsWith("http:", StringComparison.OrdinalIgnoreCase)
                    || uri.StartsWith("https:", StringComparison.OrdinalIgnoreCase))
                {
                    MemoryStream stream = new MemoryStream(Encoding.UTF8.GetBytes("오프라인 전용"));
                    e.Response = Web.CoreWebView2.Environment.CreateWebResourceResponse(
                        stream, 403, "Forbidden", "Content-Type: text/plain; charset=utf-8");
                }
            };

            Web.CoreWebView2.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs e)
            {
                string msgSrc = e.Source == null ? "" : e.Source;
                if (!msgSrc.StartsWith("about:blank", StringComparison.OrdinalIgnoreCase)
                    && !msgSrc.StartsWith("data:text/html", StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
                HandleRequest(e.WebMessageAsJson);
            };

            byte[] htmlBytes = ReadResource("editor.html");
            if (htmlBytes == null)
            {
                throw new InvalidOperationException("내장된 에디터 화면 리소스를 찾을 수 없습니다.");
            }
            string html = Encoding.UTF8.GetString(htmlBytes);

            Web.CoreWebView2.NavigationCompleted += async delegate(object sender, CoreWebView2NavigationCompletedEventArgs e)
            {
                if (!e.IsSuccess)
                {
                    Fail(new InvalidOperationException("화면 초기화에 실패했습니다: " + e.WebErrorStatus));
                    return;
                }

                if (TestRoot != null && !selfTestStarted)
                {
                    selfTestStarted = true;
                    try
                    {
                        await SelfTest();
                    }
                    catch (Exception ex)
                    {
                        Fail(ex);
                    }
                }
            };

            Web.CoreWebView2.NavigateToString(html);
        }

        private static void Fail(Exception ex)
        {
            ExitCode = 1;
            if (TestRoot != null)
            {
                try
                {
                    string path = Path.Combine(TestRoot, "failure.txt");
                    File.WriteAllText(path, ex.ToString(), Encoding.UTF8);
                }
                catch (Exception)
                {
                }
                Console.Error.WriteLine(ex.Message);
            }
            else
            {
                try
                {
                    MessageBox.Show(ex.Message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                catch (Exception)
                {
                }
            }

            closingAllowed = true;
            if (MainForm != null && !MainForm.IsDisposed)
            {
                try
                {
                    MainForm.Close();
                }
                catch (Exception)
                {
                }
            }
        }

        private static Assembly OnAssemblyResolve(object sender, ResolveEventArgs args)
        {
            string name = new AssemblyName(args.Name).Name;
            if (name == "Microsoft.Web.WebView2.Core" || name == "Microsoft.Web.WebView2.WinForms")
            {
                byte[] bytes = ReadResource(name + ".dll");
                if (bytes != null)
                {
                    return Assembly.Load(bytes);
                }
            }
            return null;
        }

        public static byte[] Resource(string name)
        {
            return ReadResource(name);
        }

        private static byte[] ReadResource(string name)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            Stream stream = assembly.GetManifestResourceStream(name);
            if (stream == null)
            {
                stream = assembly.GetManifestResourceStream("WanderingSwordSaveEditor." + name);
            }
            if (stream == null)
            {
                return null;
            }
            using (stream)
            {
                long length = stream.Length;
                byte[] buffer = new byte[(int)length];
                int read = 0;
                while (read < buffer.Length)
                {
                    int n = stream.Read(buffer, read, buffer.Length - read);
                    if (n <= 0) break;
                    read += n;
                }
                return buffer;
            }
        }

        public static void CheckGameNotRunning()
        {
            if (String.Equals(Environment.GetEnvironmentVariable("WS_SIMULATE_GAME_RUNNING"), "1", StringComparison.Ordinal))
            {
                throw new IOException(GameRunningMessage);
            }
            Process[] processes = Process.GetProcesses();
            try
            {
                for (int i = 0; i < processes.Length; i++)
                {
                    string pname = null;
                    try
                    {
                        pname = processes[i].ProcessName;
                    }
                    catch (Exception)
                    {
                        continue;
                    }
                    if (String.IsNullOrEmpty(pname)) continue;
                    string lower = pname.ToLowerInvariant();
                    if (lower.IndexOf("jh-win64-shipping", StringComparison.Ordinal) >= 0
                        || lower.IndexOf("wandering_sword", StringComparison.Ordinal) >= 0)
                    {
                        throw new IOException(GameRunningMessage);
                    }
                }
            }
            finally
            {
                for (int i = 0; i < processes.Length; i++)
                {
                    try { processes[i].Dispose(); }
                    catch (Exception) { }
                }
            }
        }

        public static string FindDefaultSaveFile()
        {
            try
            {
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (!String.IsNullOrEmpty(local))
                {
                    string saved = Path.Combine(Path.Combine(local, "Wandering_Sword"), "Saved");
                    if (Directory.Exists(saved))
                    {
                        string[] dirs = Directory.GetDirectories(saved);
                        Array.Sort(dirs, StringComparer.OrdinalIgnoreCase);
                        for (int i = 0; i < dirs.Length; i++)
                        {
                            string id = Path.GetFileName(dirs[i]);
                            if (String.IsNullOrEmpty(id)) continue;
                            bool allDigits = true;
                            for (int c = 0; c < id.Length; c++)
                            {
                                if (id[c] < '0' || id[c] > '9') { allDigits = false; break; }
                            }
                            if (!allDigits) continue;
                            string games = Path.Combine(dirs[i], "SaveGames");
                            if (!Directory.Exists(games)) continue;
                            string zero = Path.Combine(games, "0.sav");
                            if (File.Exists(zero) && SaveStore.IsSaveExtension(zero)) return zero;
                            string[] savs = Directory.GetFiles(games, "*.sav");
                            Array.Sort(savs, StringComparer.OrdinalIgnoreCase);
                            for (int s = 0; s < savs.Length; s++)
                            {
                                if (SaveStore.IsSaveExtension(savs[s])) return savs[s];
                            }
                        }

                        string flatZero = Path.Combine(Path.Combine(saved, "SaveGames"), "0.sav");
                        if (File.Exists(flatZero) && SaveStore.IsSaveExtension(flatZero)) return flatZero;
                    }
                }

                string beside = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "0.sav");
                if (File.Exists(beside) && SaveStore.IsSaveExtension(beside)) return beside;
            }
            catch (Exception)
            {
            }
            return null;
        }

        private static string GetString(Dictionary<string, object> root, string key)
        {
            object value;
            if (root == null || key == null || !root.TryGetValue(key, out value) || value == null)
            {
                return null;
            }
            return value as string ?? value.ToString();
        }

        private static void Reply(string id, object seq, Dictionary<string, object> payload)
        {
            if (payload == null) payload = new Dictionary<string, object>();
            payload["id"] = id;
            if (seq != null) payload["seq"] = seq;
            if (Web != null && Web.CoreWebView2 != null)
            {
                Web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(payload));
            }
        }

        private static void HandleRequest(string raw)
        {
            Dictionary<string, object> root = null;
            string id = null;
            object seqValue = null;
            try
            {
                root = Json.DeserializeObject(raw) as Dictionary<string, object>;
                if (root == null) return;
                string kind = GetString(root, "kind");
                id = GetString(root, "id");
                root.TryGetValue("seq", out seqValue);

                if (kind == "ready")
                {
                    if (TestRoot == null)
                    {
                        string candidate = FindDefaultSaveFile();
                        if (candidate != null && File.Exists(candidate))
                        {
                            try
                            {
                                byte[] bytes = SaveStore.Read(candidate);
                                SaveStore.ValidateSaveBytes(bytes);
                                activePath = Path.GetFullPath(candidate);
                                activeHash = SaveStore.Hash(bytes);
                                activeSession = Guid.NewGuid().ToString("N");
                                lastFolder = Path.GetDirectoryName(activePath);
                                Dictionary<string, object> payload = new Dictionary<string, object>();
                                payload["ok"] = true;
                                payload["session"] = activeSession;
                                payload["fileName"] = Path.GetFileName(activePath);
                                payload["path"] = activePath;
                                payload["base64"] = Convert.ToBase64String(bytes);
                                Reply(id, seqValue, payload);
                                return;
                            }
                            catch (Exception)
                            {
                            }
                        }
                        Dictionary<string, object> demoPayload = new Dictionary<string, object>();
                        demoPayload["ok"] = true;
                        demoPayload["demo"] = true;
                        Reply(id, seqValue, demoPayload);
                        return;
                    }
                    Dictionary<string, object> testReady = new Dictionary<string, object>();
                    testReady["ok"] = true;
                    Reply(id, seqValue, testReady);
                    return;
                }

                if (kind == "open")
                {
                    string fullPath = null;
                    if (TestRoot != null)
                    {
                        fullPath = Path.Combine(Path.Combine(TestRoot, "SaveGames"), "0.sav");
                    }
                    else
                    {
                        using (OpenFileDialog dialog = new OpenFileDialog())
                        {
                            dialog.Filter = "일검풍운결 세이브 (*.sav)|*.sav";
                            dialog.Title = "일검풍운결 세이브 파일 열기";
                            dialog.CheckFileExists = true;
                            string initDir = lastFolder;
                            if (String.IsNullOrEmpty(initDir))
                            {
                                string defFile = FindDefaultSaveFile();
                                if (!String.IsNullOrEmpty(defFile)) initDir = Path.GetDirectoryName(defFile);
                            }
                            if (!String.IsNullOrEmpty(initDir) && Directory.Exists(initDir))
                            {
                                dialog.InitialDirectory = initDir;
                            }
                            if (dialog.ShowDialog(MainForm) != DialogResult.OK)
                            {
                                Dictionary<string, object> cancel = new Dictionary<string, object>();
                                cancel["ok"] = false;
                                cancel["error"] = "취소됨";
                                Reply(id, seqValue, cancel);
                                return;
                            }
                            fullPath = dialog.FileName;
                        }
                    }

                    byte[] bytes = SaveStore.Read(fullPath);
                    SaveStore.ValidateSaveBytes(bytes);
                    activePath = Path.GetFullPath(fullPath);
                    activeHash = SaveStore.Hash(bytes);
                    activeSession = Guid.NewGuid().ToString("N");
                    lastFolder = Path.GetDirectoryName(activePath);
                    Dictionary<string, object> payload = new Dictionary<string, object>();
                    payload["ok"] = true;
                    payload["session"] = activeSession;
                    payload["fileName"] = Path.GetFileName(activePath);
                    payload["path"] = activePath;
                    payload["base64"] = Convert.ToBase64String(bytes);
                    Reply(id, seqValue, payload);
                    return;
                }

                if (kind == "save")
                {
                    CheckGameNotRunning();
                    if (activePath == null) throw new IOException("먼저 세이브 파일을 열어야 합니다.");
                    string reqSession = GetString(root, "session");
                    if (!String.Equals(reqSession, activeSession, StringComparison.Ordinal))
                    {
                        throw new IOException("세션 토큰이 일치하지 않습니다. 세이브 파일을 다시 불러오세요.");
                    }
                    byte[] data = DecodeAndValidateSaveBase64(GetString(root, "base64"), "저장할 세이브 데이터가 비어 있습니다.");
                    string backup = SaveStore.ReplaceWithBackup(activePath, activeHash, data);
                    activeHash = SaveStore.Hash(data);
                    activeSession = Guid.NewGuid().ToString("N");

                    Dictionary<string, object> payload = new Dictionary<string, object>();
                    payload["ok"] = true;
                    payload["session"] = activeSession;
                    payload["path"] = activePath;
                    payload["backup"] = backup;
                    payload["backupFile"] = Path.GetFileName(backup);
                    Reply(id, seqValue, payload);
                    return;
                }

                if (kind == "save-copy")
                {
                    CheckGameNotRunning();
                    string dest = null;
                    using (SaveFileDialog dialog = new SaveFileDialog())
                    {
                        dialog.Filter = "일검풍운결 세이브 (*.sav)|*.sav";
                        dialog.Title = "세이브 사본 저장";
                        dialog.DefaultExt = "sav";
                        dialog.AddExtension = true;
                        dialog.OverwritePrompt = true;
                        if (!String.IsNullOrEmpty(lastFolder) && Directory.Exists(lastFolder))
                        {
                            dialog.InitialDirectory = lastFolder;
                        }
                        string suggested = GetString(root, "fileName");
                        dialog.FileName = !String.IsNullOrEmpty(suggested) ? suggested : "0_copy.sav";
                        if (dialog.ShowDialog(MainForm) != DialogResult.OK)
                        {
                            Dictionary<string, object> cancel = new Dictionary<string, object>();
                            cancel["ok"] = false;
                            cancel["error"] = "취소됨";
                            Reply(id, seqValue, cancel);
                            return;
                        }
                        dest = dialog.FileName;
                    }
                    CheckGameNotRunning();
                    if (!SaveStore.IsSaveExtension(dest))
                    {
                        throw new IOException("세이브 확장자(.sav)만 허용됩니다: " + dest);
                    }
                    byte[] data = DecodeAndValidateSaveBase64(GetString(root, "base64"), "복사할 세이브 데이터가 비어 있습니다.");
                    string backup = null;
                    if (File.Exists(dest))
                    {
                        backup = SaveStore.ReplaceWithBackup(dest, SaveStore.Hash(SaveStore.Read(dest)), data);
                    }
                    else if (activePath != null && File.Exists(activePath))
                    {
                        backup = SaveStore.CopyWithBackup(activePath, dest, activeHash, data);
                    }
                    else
                    {
                        SaveStore.WriteNew(dest, data);
                    }
                    Dictionary<string, object> payload = new Dictionary<string, object>();
                    payload["ok"] = true;
                    payload["path"] = Path.GetFullPath(dest);
                    payload["backup"] = backup;
                    payload["backupFile"] = backup != null ? Path.GetFileName(backup) : null;
                    Reply(id, seqValue, payload);
                    return;
                }

                throw new IOException("알 수 없는 요청 종류입니다: " + kind);
            }
            catch (Exception ex)
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["ok"] = false;
                err["error"] = ex.Message;
                Reply(id, seqValue, err);
            }
        }

        private static byte[] DecodeAndValidateSaveBase64(string b64, string emptyMessage)
        {
            if (String.IsNullOrEmpty(b64)) throw new IOException(emptyMessage);
            byte[] data;
            try
            {
                data = Convert.FromBase64String(b64);
            }
            catch (FormatException ex)
            {
                throw new IOException("세이브 인코딩 형식이 올바르지 않습니다.", ex);
            }
            SaveStore.ValidateSaveBytes(data);
            return data;
        }

        private static async Task Until(string expression)
        {
            Stopwatch watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < 30000)
            {
                string result = await Eval(expression);
                if (result != null && result.Trim() == "true")
                {
                    return;
                }
                await Task.Delay(80);
            }
            throw new TimeoutException("조건 대기 시간 초과: " + expression);
        }

        private static async Task<string> Eval(string expression)
        {
            return await Web.CoreWebView2.ExecuteScriptAsync(expression);
        }

        private static async Task SelfTest()
        {
            CheckGameNotRunning();
            await Until("typeof window.WanderingSwordEditorUI === 'object' && typeof window.WanderingSwordEditorCore === 'object' && typeof window.WanderingSwordCodec === 'object' && !window.WanderingSwordEditorUI.isBusy()");

            string saveDir = Path.Combine(TestRoot, "SaveGames");
            Directory.CreateDirectory(saveDir);
            string savPath = Path.Combine(saveDir, "0.sav");

            string sourceMode = "demo";
            byte[] seedBytes;
            if (SeedSourceSav != null)
            {
                sourceMode = "seed";
                seedBytes = SaveStore.Read(SeedSourceSav);
            }
            else
            {
                await Eval("(function(){window.__demoB64=null;window.__demoErr=null;try{window.WanderingSwordEditorCore.createDemoSavBytes(window.WanderingSwordCatalog,window.WanderingSwordCodec).then(function(u){var bin='';for(var i=0;i<u.length;i++)bin+=String.fromCharCode(u[i]);window.__demoB64=btoa(bin);}).catch(function(e){window.__demoErr=String(e);});}catch(e){window.__demoErr=String(e);}return true;})()");
                await Until("window.__demoB64 !== null || window.__demoErr !== null");
                string demoErr = UnquoteJson(await Eval("window.__demoErr || ''"));
                if (!String.IsNullOrEmpty(demoErr))
                {
                    throw new IOException(demoErr);
                }
                string b64 = UnquoteJson(await Eval("window.__demoB64"));
                seedBytes = Convert.FromBase64String(b64);
            }

            if (File.Exists(savPath)) File.Delete(savPath);
            SaveStore.WriteNew(savPath, seedBytes);
            string originalHash = SaveStore.Hash(seedBytes);

            await Eval("document.getElementById('btn-native-open').click();");
            await Until("!window.WanderingSwordEditorUI.isBusy() && window.WanderingSwordEditorUI.getNativeSession() !== null && window.WanderingSwordEditorUI.getSession().isLoaded()");

            await Eval("window.WanderingSwordEditorUI.applyPresetDirect('wealth_max');");
            await Until("window.hasUnsavedChanges() === true && window.WanderingSwordEditorUI.getSession().validate().valid === true");

            await Eval("window.__prevSession = window.WanderingSwordEditorUI.getNativeSession(); document.getElementById('btn-native-save').click();");
            await Until("!window.WanderingSwordEditorUI.isBusy() && window.hasUnsavedChanges() === false && window.WanderingSwordEditorUI.getNativeSession() !== window.__prevSession");

            string[] baks = Directory.GetFiles(saveDir, "0.sav.backup-*.bak");
            if (baks.Length != 1)
            {
                throw new IOException("자동 백업 파일 개수가 예상과 다릅니다: " + baks.Length);
            }
            string backupHash = SaveStore.Hash(File.ReadAllBytes(baks[0]));
            if (!String.Equals(backupHash, originalHash, StringComparison.OrdinalIgnoreCase))
            {
                throw new IOException("백업 파일 해시 검증에 실패했습니다.");
            }

            await Eval("window.__prevSession = window.WanderingSwordEditorUI.getNativeSession(); document.getElementById('btn-native-open').click();");
            await Until("!window.WanderingSwordEditorUI.isBusy() && window.WanderingSwordEditorUI.getNativeSession() !== null && window.WanderingSwordEditorUI.getNativeSession() !== window.__prevSession && window.WanderingSwordEditorUI.getSession().isLoaded()");

            string checkJson = UnquoteJson(await Eval("(function(){var s=window.WanderingSwordEditorUI.getSession();var sum=s.getSummary();var body=document.body?document.body.innerText:'';var hanzi=/[\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff]/.test(body);return JSON.stringify({valid:s.validate().valid,money:sum.money,skillExp:sum.hero?sum.hero.skillExp:0,jingMaiPoint:sum.hero?sum.hero.jingMaiPoint:0,hanzi:hanzi});})()"));
            Dictionary<string, object> check = Json.DeserializeObject(checkJson) as Dictionary<string, object>;
            if (check == null)
            {
                throw new IOException("자체 점검 요약 결과를 해석하지 못했습니다.");
            }
            bool valid = check["valid"] is bool && (bool)check["valid"];
            bool hasHanzi = check["hanzi"] is bool && (bool)check["hanzi"];
            int money = ToInt(check["money"]);
            int skillExp = ToInt(check["skillExp"]);
            int jingMaiPoint = ToInt(check["jingMaiPoint"]);

            if (!valid || hasHanzi || money != 9999999 || skillExp < 999999 || jingMaiPoint < 99999)
            {
                throw new IOException("자체 점검 수치 검증 실패: valid=" + valid + " hanzi=" + hasHanzi + " money=" + money);
            }

            Dictionary<string, object> receipt = new Dictionary<string, object>();
            receipt["status"] = "PASS";
            receipt["sourceMode"] = sourceMode;
            receipt["money"] = money;
            receipt["skillExp"] = skillExp;
            receipt["jingMaiPoint"] = jingMaiPoint;
            receipt["backupVerified"] = true;
            receipt["hanziZero"] = !hasHanzi;
            receipt["htmlHash"] = SaveStore.Hash(ReadResource("editor.html"));

            File.WriteAllText(Path.Combine(TestRoot, "receipt.json"), Json.Serialize(receipt), Encoding.UTF8);
            File.WriteAllText(Path.Combine(TestRoot, "selftest.txt"), "SELFTEST PASS\n", Encoding.UTF8);
            Console.WriteLine("SELFTEST PASS");

            closingAllowed = true;
            MainForm.Close();
        }

        private static int ToInt(object value)
        {
            if (value == null) return 0;
            if (value is int) return (int)value;
            if (value is long) return (int)(long)value;
            if (value is double) return (int)(double)value;
            int parsed;
            return Int32.TryParse(value.ToString(), out parsed) ? parsed : 0;
        }

        private static string UnquoteJson(string value)
        {
            if (value == null) return null;
            string trimmed = value.Trim();
            if (trimmed.Length >= 2 && trimmed[0] == '"' && trimmed[trimmed.Length - 1] == '"')
            {
                try
                {
                    string s = Json.DeserializeObject(trimmed) as string;
                    if (s != null) return s;
                }
                catch (Exception)
                {
                }
                return trimmed.Substring(1, trimmed.Length - 2);
            }
            return trimmed;
        }
    }
}
