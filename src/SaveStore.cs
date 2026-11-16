using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace WanderingSwordSaveEditor
{
    public static class SaveStore
    {
        public const long MaxSaveBytes = 64L * 1024L * 1024L;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            public uint dwFileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftLastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftLastWriteTime;
            public uint dwVolumeSerialNumber;
            public uint nFileSizeHigh;
            public uint nFileSizeLow;
            public uint nNumberOfLinks;
            public uint nFileIndexHigh;
            public uint nFileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            IntPtr hFile,
            out BY_HANDLE_FILE_INFORMATION lpFileInformation);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            IntPtr hFile,
            StringBuilder lpszFilePath,
            uint cchFilePath,
            uint dwFlags);

        public static bool IsSaveExtension(string path)
        {
            return IsAllowedWritePath(path, false);
        }

        public static string Hash(byte[] bytes)
        {
            if (bytes == null) throw new ArgumentNullException("bytes");
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(bytes);
                StringBuilder sb = new StringBuilder(hash.Length * 2);
                for (int i = 0; i < hash.Length; i++) sb.Append(hash[i].ToString("x2"));
                return sb.ToString();
            }
        }

        public static void NoLinks(string path)
        {
            if (String.IsNullOrEmpty(path)) throw new IOException("경로가 비어 있습니다.");
            string trimmed = path.TrimStart();
            if (trimmed.StartsWith("\\\\", StringComparison.Ordinal) || trimmed.StartsWith("//", StringComparison.Ordinal))
                throw new IOException("네트워크 공유 경로는 허용되지 않습니다: " + path);
            string full;
            try
            {
                full = Path.GetFullPath(path);
            }
            catch (Exception ex)
            {
                throw new IOException("유효하지 않은 경로입니다: " + path, ex);
            }
            if (full.IndexOf(':', 2) >= 0)
                throw new IOException("대체 데이터 스트림 경로는 허용되지 않습니다: " + path);
            CheckNoReparse(full);
            string current = full;
            while (!String.IsNullOrEmpty(current))
            {
                string parent = Path.GetDirectoryName(current);
                if (String.IsNullOrEmpty(parent)) break;
                if (Directory.Exists(parent)) CheckNoReparse(parent);
                if (String.Equals(Path.GetPathRoot(parent), parent, StringComparison.OrdinalIgnoreCase)) break;
                current = parent;
            }
        }

        public static byte[] Read(string path)
        {
            NoLinks(path);
            if (!IsSaveExtension(path))
                throw new IOException("세이브 확장자(.sav)만 읽을 수 있습니다: " + path);
            string full = Path.GetFullPath(path);
            using (FileStream stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                VerifyHandle(stream, full);
                if (stream.Length < 1L || stream.Length > MaxSaveBytes)
                    throw new IOException("세이브 파일 크기가 허용 범위를 벗어났습니다: " + full);
                return ReadAllFromStream(stream);
            }
        }

        public static void WriteNew(string path, byte[] data, Action<Stream, byte[]> writer = null)
        {
            if (path == null) throw new ArgumentNullException("path");
            if (data == null) throw new ArgumentNullException("data");
            if (data.Length < 1 || data.LongLength > MaxSaveBytes)
                throw new IOException("세이브 데이터 크기가 허용 범위를 벗어났습니다.");
            NoLinks(path);
            if (!IsAllowedWritePath(path, true))
                throw new IOException("쓰기 가능한 세이브 확장자(.sav/.bak)가 아닙니다: " + path);
            string full = Path.GetFullPath(path);
            bool created = false;
            try
            {
                using (FileStream stream = new FileStream(full, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
                {
                    created = true;
                    VerifyHandle(stream, full);
                    WriteStreamPayload(stream, data, writer);
                }
            }
            catch
            {
                if (created)
                {
                    try { if (File.Exists(full)) File.Delete(full); }
                    catch { }
                }
                throw;
            }
        }

        public static string ReplaceWithBackup(string path, string expectedHash, byte[] data)
        {
            if (data == null) throw new ArgumentNullException("data");
            if (data.Length < 1 || data.LongLength > MaxSaveBytes)
                throw new IOException("세이브 데이터 크기가 허용 범위를 벗어났습니다.");
            NoLinks(path);
            if (!IsSaveExtension(path))
                throw new IOException("세이브 확장자(.sav)만 교체할 수 있습니다: " + path);
            string full = Path.GetFullPath(path);
            using (FileStream target = new FileStream(full, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                VerifyHandle(target, full);
                byte[] before = ReadAllFromStream(target);
                if (!String.Equals(Hash(before), expectedHash, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("세이브 파일 해시가 예상 값과 다릅니다: " + full);
                string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture);
                string backup = full + ".backup-" + stamp + "-" + Guid.NewGuid().ToString("N") + ".bak";
                WriteNew(backup, before);
                using (FileStream check = new FileStream(backup, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    VerifyHandle(check, backup);
                    byte[] backupBytes = ReadAllFromStream(check);
                    if (!String.Equals(Hash(backupBytes), expectedHash, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("백업 파일 검증에 실패했습니다: " + backup);
                }
                target.Position = 0;
                UpdateOrRestore(target, before, data, backup);
                return backup;
            }
        }

        public static string CopyWithBackup(
            string source,
            string destination,
            string expectedHash,
            byte[] data,
            Action<Stream, byte[]> writer = null)
        {
            if (data == null) throw new ArgumentNullException("data");
            if (data.Length < 1 || data.LongLength > MaxSaveBytes)
                throw new IOException("세이브 데이터 크기가 허용 범위를 벗어났습니다.");
            if (!IsSaveExtension(source) || !IsSaveExtension(destination))
                throw new IOException("세이브 확장자(.sav)가 아닙니다: " + source + " / " + destination);
            NoLinks(source);
            NoLinks(destination);
            string sourceFull = Path.GetFullPath(source);
            string destFull = Path.GetFullPath(destination);
            if (String.Equals(sourceFull, destFull, StringComparison.OrdinalIgnoreCase))
                throw new IOException("원본과 대상 경로가 같습니다: " + destFull);
            if (File.Exists(destFull))
                throw new IOException("대상 파일이 이미 존재합니다: " + destFull);
            byte[] original = Read(sourceFull);
            if (!String.Equals(Hash(original), expectedHash, StringComparison.OrdinalIgnoreCase))
                throw new IOException("원본 세이브 해시가 예상 값과 다릅니다: " + sourceFull);
            string guid = Guid.NewGuid().ToString("N");
            string backup = destFull + ".original-" + guid + ".bak";
            WriteNew(backup, original);
            string pending = destFull + ".pending-" + guid;
            bool pendingCreated = false;
            try
            {
                using (FileStream stream = new FileStream(pending, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
                {
                    pendingCreated = true;
                    VerifyHandle(stream, pending);
                    WriteStreamPayload(stream, data, writer);
                }
                if (File.Exists(destFull))
                    throw new IOException("대상 파일이 이미 존재합니다: " + destFull);
                File.Move(pending, destFull);
                pendingCreated = false;
                return backup;
            }
            catch (IOException ex)
            {
                if (pendingCreated)
                {
                    try { if (File.Exists(pending)) File.Delete(pending); }
                    catch { }
                }
                throw new IOException("복사 저장 실패 (원본 백업 보존됨: " + backup + "): " + ex.Message, ex);
            }
            catch
            {
                if (pendingCreated)
                {
                    try { if (File.Exists(pending)) File.Delete(pending); }
                    catch { }
                }
                throw;
            }
        }

        public static void UpdateOrRestore(Stream target, byte[] before, byte[] data, string backup)
        {
            if (target == null) throw new ArgumentNullException("target");
            if (before == null) throw new ArgumentNullException("before");
            if (data == null) throw new ArgumentNullException("data");
            try
            {
                WriteAndVerify(target, data);
            }
            catch (Exception ex)
            {
                try
                {
                    target.Seek(0, SeekOrigin.Begin);
                    target.SetLength(0);
                    target.Write(before, 0, before.Length);
                    FlushStream(target);
                }
                catch (Exception rollbackEx)
                {
                    throw new IOException("세이브 갱신 및 자동 원상복구에 실패했습니다. 백업: " + backup, rollbackEx);
                }
                throw new IOException("세이브 갱신 실패로 원본 바이트를 복원했습니다. 백업: " + backup, ex);
            }
        }

        public static void WriteAndVerify(Stream target, byte[] data)
        {
            if (target == null) throw new ArgumentNullException("target");
            if (data == null) throw new ArgumentNullException("data");
            if (data.Length < 1 || data.LongLength > MaxSaveBytes)
                throw new IOException("세이브 데이터 크기가 허용 범위를 벗어났습니다.");
            target.Position = 0;
            target.SetLength(0);
            target.Write(data, 0, data.Length);
            FlushStream(target);
            if (target.Length != data.Length)
                throw new IOException("저장 길이 검증에 실패했습니다.");
            target.Seek(0, SeekOrigin.Begin);
            byte[] check = new byte[data.Length];
            int read = 0;
            while (read < check.Length)
            {
                int n = target.Read(check, read, check.Length - read);
                if (n <= 0) throw new IOException("저장 내용 읽기 검증에 실패했습니다.");
                read += n;
            }
            if (!String.Equals(Hash(check), Hash(data), StringComparison.OrdinalIgnoreCase))
                throw new IOException("저장 내용 해시 검증에 실패했습니다.");
        }

        private static void VerifyHandle(FileStream stream, string expectedFullPath)
        {
            if (stream == null) throw new ArgumentNullException("stream");
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) return;
            IntPtr handle = stream.SafeFileHandle.DangerousGetHandle();
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info))
                throw new IOException("파일 핸들 정보를 확인하지 못했습니다: " + expectedFullPath);
            if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                throw new IOException("재분석 지점 파일은 사용할 수 없습니다: " + expectedFullPath);
            if (info.nNumberOfLinks > 1)
                throw new IOException("하드 링크된 파일은 사용할 수 없습니다: " + expectedFullPath);
            StringBuilder sb = new StringBuilder(512);
            uint len = GetFinalPathNameByHandleW(handle, sb, (uint)sb.Capacity, 0);
            if (len >= (uint)sb.Capacity)
            {
                sb = new StringBuilder((int)len + 1);
                len = GetFinalPathNameByHandleW(handle, sb, (uint)sb.Capacity, 0);
            }
            if (len == 0 || len >= (uint)sb.Capacity)
                throw new IOException("최종 파일 경로를 확인하지 못했습니다: " + expectedFullPath);
            string finalPath = sb.ToString();
            if (finalPath.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase))
                throw new IOException("네트워크 공유 최종 경로는 사용할 수 없습니다: " + finalPath);
            if (finalPath.StartsWith("\\\\?\\", StringComparison.Ordinal))
                finalPath = finalPath.Substring(4);
            if (!String.Equals(Path.GetFullPath(finalPath), Path.GetFullPath(expectedFullPath), StringComparison.OrdinalIgnoreCase))
                throw new IOException("파일 핸들의 최종 경로가 예상 경로와 다릅니다: " + finalPath);
        }

        private static void CheckNoReparse(string path)
        {
            if (!File.Exists(path) && !Directory.Exists(path)) return;
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("재분석 지점 경로는 사용할 수 없습니다: " + path);
        }

        private static void WriteStreamPayload(Stream stream, byte[] data, Action<Stream, byte[]> writer)
        {
            if (writer != null)
            {
                writer(stream, data);
                FlushStream(stream);
            }
            else
            {
                WriteAndVerify(stream, data);
            }
        }

        private static void FlushStream(Stream target)
        {
            FileStream fs = target as FileStream;
            if (fs != null) fs.Flush(true);
            else target.Flush();
        }

        private static byte[] ReadAllFromStream(Stream stream)
        {
            long pos = stream.Position;
            try
            {
                stream.Seek(0, SeekOrigin.Begin);
                if (stream.Length < 1L || stream.Length > MaxSaveBytes)
                    throw new IOException("세이브 데이터 길이가 허용 범위를 벗어났습니다.");
                int size = (int)stream.Length;
                byte[] result = new byte[size];
                int read = 0;
                while (read < size)
                {
                    int n = stream.Read(result, read, size - read);
                    if (n <= 0) throw new IOException("세이브 데이터를 끝까지 읽지 못했습니다.");
                    read += n;
                }
                return result;
            }
            finally
            {
                stream.Position = pos;
            }
        }

        private static bool HasInvalidColon(string path)
        {
            if (String.IsNullOrEmpty(path)) return false;
            for (int i = 0; i < path.Length; i++)
            {
                if (path[i] != ':') continue;
                if (i == 1 && path.Length >= 3 &&
                    ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) &&
                    (path[2] == '\\' || path[2] == '/'))
                    continue;
                return true;
            }
            return false;
        }

        private static bool IsAllowedWritePath(string path, bool allowBackup)
        {
            try
            {
                if (String.IsNullOrEmpty(path) || HasInvalidColon(path)) return false;
                string name = Path.GetFileName(path);
                if (String.IsNullOrEmpty(name) || name.IndexOf(':') >= 0) return false;
                int dot = name.IndexOf('.');
                string stem = (dot >= 0 ? name.Substring(0, dot) : name).TrimEnd(' ', '.');
                if (IsReservedDeviceName(stem)) return false;
                string ext = Path.GetExtension(name);
                if (String.Equals(ext, ".sav", StringComparison.OrdinalIgnoreCase)) return true;
                return allowBackup && String.Equals(ext, ".bak", StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        private static bool IsReservedDeviceName(string stem)
        {
            if (String.IsNullOrEmpty(stem)) return false;
            string s = stem.TrimEnd(' ', '.').ToUpperInvariant();
            if (s == "CON" || s == "PRN" || s == "AUX" || s == "NUL") return true;
            if (s.Length == 4 && (s.StartsWith("COM", StringComparison.Ordinal) || s.StartsWith("LPT", StringComparison.Ordinal)))
                return s[3] >= '1' && s[3] <= '9';
            return false;
        }

        public static void ValidateSaveBytes(byte[] data)
        {
            if (data == null || data.Length < 8 || data.LongLength > MaxSaveBytes)
                throw new IOException("세이브 데이터 크기가 올바르지 않습니다.");

            int saveVersion = BitConverter.ToInt32(data, 0);
            if (saveVersion < 1 || saveVersion > 30)
                throw new IOException("세이브 파일 버전이 올바르지 않습니다.");

            byte[] inner;
            if (saveVersion > 5)
            {
                if (data.Length < 18)
                    throw new IOException("압축 세이브 헤더 길이가 부족합니다.");

                int uncompSize = BitConverter.ToInt32(data, 4);
                int compSize = BitConverter.ToInt32(data, 8);
                if (uncompSize <= 0 || uncompSize > MaxSaveBytes)
                    throw new IOException("압축 해제 크기가 허용 범위를 벗어났습니다.");
                if (compSize < 6 || 12L + compSize != data.LongLength)
                    throw new IOException("압축 세이브 길이가 헤더와 일치하지 않습니다.");

                byte cmf = data[12];
                byte flg = data[13];
                if ((cmf & 0x0F) != 8 || (cmf >> 4) > 7 || (((cmf << 8) + flg) % 31) != 0 || (flg & 0x20) != 0)
                    throw new IOException("압축 스트림 헤더가 손상되었습니다.");

                inner = new byte[uncompSize];
                int total = 0;
                try
                {
                    using (SingleByteSliceStream ms = new SingleByteSliceStream(data, 14, compSize - 6))
                    using (DeflateStream ds = new DeflateStream(ms, CompressionMode.Decompress))
                    {
                        while (total < uncompSize)
                        {
                            int read = ds.Read(inner, total, uncompSize - total);
                            if (read <= 0)
                                throw new IOException("압축 해제 데이터가 불완전합니다.");
                            total += read;
                        }
                        if (ds.ReadByte() != -1)
                            throw new IOException("압축 해제 길이가 헤더와 일치하지 않습니다.");
                        if (!IsDeflateStreamFinished(ds))
                            throw new IOException("압축 스트림이 정상 종료되지 않았습니다.");
                        if (!ms.IsFullyConsumed)
                            throw new IOException("압축 스트림에 잔여 바이트가 남아 있습니다.");
                    }
                }
                catch (InvalidDataException ex)
                {
                    throw new IOException("세이브 압축 스트림이 손상되었습니다.", ex);
                }

                int adlerPos = data.Length - 4;
                uint storedAdler = ((uint)data[adlerPos] << 24)
                    | ((uint)data[adlerPos + 1] << 16)
                    | ((uint)data[adlerPos + 2] << 8)
                    | data[adlerPos + 3];
                if (storedAdler != ComputeAdler32(inner))
                    throw new IOException("압축 세이브 무결성 검사값이 일치하지 않습니다.");
            }
            else
            {
                inner = new byte[data.Length - 4];
                Buffer.BlockCopy(data, 4, inner, 0, inner.Length);
            }

            if (inner.Length < 34
                || inner[0] != (byte)'G'
                || inner[1] != (byte)'V'
                || inner[2] != (byte)'A'
                || inner[3] != (byte)'S')
            {
                throw new IOException("유효한 일검풍운결 세이브 헤더가 아닙니다.");
            }

            int pos = 22;
            ReadGvasString(inner, ref pos);
            if (pos + 8 > inner.Length)
                throw new IOException("세이브 헤더 구조가 손상되었습니다.");
            pos += 4;
            int cvCount = BitConverter.ToInt32(inner, pos);
            pos += 4;
            if (cvCount < 0 || cvCount > 4096)
                throw new IOException("세이브 사용자 버전 목록 크기가 비정상적입니다.");
            long skip = (long)cvCount * 20L;
            if (skip > int.MaxValue || pos + skip > inner.Length)
                throw new IOException("세이브 사용자 버전 목록이 손상되었습니다.");
            pos += (int)skip;

            string cls = ReadGvasString(inner, ref pos);
            if (cls != "/Script/JH.JHSaveGame" && cls != "/Script/JH.JHSaveGameConfig")
                throw new IOException("지원하지 않는 일검풍운결 세이브 형식입니다.");

            if (cls == "/Script/JH.JHSaveGame")
            {
                if (pos + 4 > inner.Length)
                    throw new IOException("세이브 헤더 구조가 손상되었습니다.");
                pos += 4;
            }

            bool foundNone = false;
            int propCount = 0;
            while (pos < inner.Length)
            {
                if (++propCount > 100000)
                    throw new IOException("세이브 속성 수가 허용 범위를 벗어났습니다.");

                string propName = ReadGvasString(inner, ref pos);
                if (propName == "None")
                {
                    foundNone = true;
                    break;
                }

                string propType = ReadGvasString(inner, ref pos);
                if (pos + 8 > inner.Length)
                    throw new IOException("세이브 속성 크기가 손상되었습니다.");
                long propSize = BitConverter.ToInt64(inner, pos);
                pos += 8;
                if (propSize < 0 || propSize > inner.Length - pos)
                    throw new IOException("세이브 속성 크기가 손상되었습니다.");

                if (propType == "BoolProperty")
                {
                    if (propSize != 0 || pos + 2 > inner.Length)
                        throw new IOException("세이브 속성 크기가 손상되었습니다.");
                    if (inner[pos + 1] != 0)
                        throw new IOException("세이브 속성 식별자 정보가 손상되었습니다.");
                    pos += 2;
                    continue;
                }

                if (propType == "IntProperty"
                    || propType == "UInt32Property"
                    || propType == "Int64Property"
                    || propType == "FloatProperty"
                    || propType == "StrProperty"
                    || propType == "NameProperty")
                {
                    if (pos + 1 > inner.Length || inner[pos] != 0)
                        throw new IOException("세이브 속성 식별자 정보가 손상되었습니다.");
                    pos += 1;
                }
                else if (propType == "ByteProperty"
                    || propType == "EnumProperty"
                    || propType == "ArrayProperty"
                    || propType == "SetProperty")
                {
                    ReadGvasString(inner, ref pos);
                    if (pos + 1 > inner.Length || inner[pos] != 0)
                        throw new IOException("세이브 속성 식별자 정보가 손상되었습니다.");
                    pos += 1;
                }
                else if (propType == "StructProperty")
                {
                    ReadGvasString(inner, ref pos);
                    if (pos + 17 > inner.Length || inner[pos + 16] != 0)
                        throw new IOException("세이브 속성 식별자 정보가 손상되었습니다.");
                    pos += 17;
                }
                else if (propType == "MapProperty")
                {
                    ReadGvasString(inner, ref pos);
                    ReadGvasString(inner, ref pos);
                    if (pos + 1 > inner.Length || inner[pos] != 0)
                        throw new IOException("세이브 속성 식별자 정보가 손상되었습니다.");
                    pos += 1;
                }
                else
                {
                    throw new IOException("지원하지 않는 세이브 속성 형식입니다.");
                }

                if (propSize > inner.Length - pos)
                    throw new IOException("세이브 속성 크기가 손상되었습니다.");
                pos += (int)propSize;
            }

            if (!foundNone)
                throw new IOException("세이브 속성 종료 표시가 누락되었습니다.");

            if (pos + 4 > inner.Length)
                throw new IOException("세이브 속성 종단 뒤 데이터가 손상되었습니다.");

            int postZero = BitConverter.ToInt32(inner, pos);
            pos += 4;
            if (postZero != 0)
                throw new IOException("세이브 속성 종단 표시값이 올바르지 않습니다.");

            if (cls == "/Script/JH.JHSaveGameConfig")
            {
                if (pos != inner.Length)
                    throw new IOException("전역 설정 세이브 끝에 잔여 바이트가 남아 있습니다.");
            }
            else
            {
                int itemCount = ReadBoundedCount(inner, ref pos, 500000);
                for (int i = 0; i < itemCount; i++)
                    SkipGvasItem(inner, ref pos, saveVersion);

                int npcCount = ReadBoundedCount(inner, ref pos, 100000);
                for (int i = 0; i < npcCount; i++)
                    SkipGvasNpc(inner, ref pos, saveVersion);

                if (pos != inner.Length)
                    throw new IOException("세이브 말미에 잔여 바이트가 남아 있습니다.");
            }
        }

        private static void SkipBytes(byte[] buf, ref int pos, long count)
        {
            if (count < 0L || count > buf.Length - pos)
                throw new IOException("세이브 말미 레코드 길이가 손상되었습니다.");
            pos += (int)count;
        }

        private static int ReadBoundedCount(byte[] buf, ref int pos, int maxCount)
        {
            if (pos + 4 > buf.Length)
                throw new IOException("세이브 배열 개수 영역이 손상되었습니다.");
            int count = BitConverter.ToInt32(buf, pos);
            pos += 4;
            if (count < 0 || count > maxCount)
                throw new IOException("세이브 배열 항목 수가 허용 범위를 벗어났습니다.");
            return count;
        }

        private static void SkipGvasItem(byte[] buf, ref int pos, int ver)
        {
            SkipBytes(buf, ref pos, 28L);

            int na = ReadBoundedCount(buf, ref pos, 1024);
            SkipBytes(buf, ref pos, (long)na * 9L);

            int nb = ReadBoundedCount(buf, ref pos, 1024);
            SkipBytes(buf, ref pos, (long)nb * 9L);

            long tail = ((ver >= 6 ? 1L : 0L) + (ver >= 9 ? 1L : 0L) + (ver >= 10 ? 1L : 0L)) * 4L;
            SkipBytes(buf, ref pos, tail);
        }

        private static void SkipGvasNpc(byte[] buf, ref int pos, int ver)
        {
            SkipBytes(buf, ref pos, 12L);

            int nAttrs = ReadBoundedCount(buf, ref pos, 1024);
            SkipBytes(buf, ref pos, (long)nAttrs * 5L);

            int nSkills = ReadBoundedCount(buf, ref pos, 100000);
            SkipBytes(buf, ref pos, (long)nSkills * 20L);

            int nMer = ReadBoundedCount(buf, ref pos, 100000);
            SkipBytes(buf, ref pos, (long)nMer * 20L);

            int nFr = ReadBoundedCount(buf, ref pos, 100000);
            SkipBytes(buf, ref pos, (long)nFr * 5L);

            int nGf = ReadBoundedCount(buf, ref pos, 100000);
            SkipBytes(buf, ref pos, (long)nGf * 5L);

            int nGh = ReadBoundedCount(buf, ref pos, 100000);
            SkipBytes(buf, ref pos, (long)nGh * 8L);

            SkipBytes(buf, ref pos, 4L);

            int n78 = ReadBoundedCount(buf, ref pos, 100000);
            for (int i = 0; i < n78; i++)
                SkipGvasItem(buf, ref pos, ver);

            int n90 = ReadBoundedCount(buf, ref pos, 100000);
            for (int i = 0; i < n90; i++)
                SkipGvasItem(buf, ref pos, ver);

            ReadGvasString(buf, ref pos);
            SkipBytes(buf, ref pos, 12L);
            ReadGvasString(buf, ref pos);
            SkipBytes(buf, ref pos, 13L);

            if (ver >= 2)
            {
                int nUsed = ReadBoundedCount(buf, ref pos, 100000);
                SkipBytes(buf, ref pos, (long)nUsed * 8L);
            }

            if (ver >= 4)
            {
                int nBuff = ReadBoundedCount(buf, ref pos, 100000);
                SkipBytes(buf, ref pos, (long)nBuff * 9L);
            }

            if (ver >= 11)
                SkipBytes(buf, ref pos, 4L);

            if (ver >= 12)
            {
                int nJm = ReadBoundedCount(buf, ref pos, 100000);
                SkipBytes(buf, ref pos, (long)nJm * 4L);
            }

            if (ver >= 13)
            {
                int nAv = ReadBoundedCount(buf, ref pos, 100000);
                for (int i = 0; i < nAv; i++)
                    ReadGvasString(buf, ref pos);
            }

            if (ver >= 14)
                SkipBytes(buf, ref pos, 4L);
        }

        public static uint ComputeAdler32(byte[] data)
        {
            if (data == null)
                throw new IOException("세이브 데이터가 비어 있습니다.");
            const uint mod = 65521;
            uint a = 1;
            uint b = 0;
            for (int i = 0; i < data.Length; i++)
            {
                a += data[i];
                if (a >= mod) a -= mod;
                b += a;
                if (b >= mod) b %= mod;
            }
            return (b << 16) | a;
        }

        private static string ReadGvasString(byte[] buf, ref int pos)
        {
            if (buf == null || pos < 0 || pos + 4 > buf.Length)
                throw new IOException("세이브 문자열 길이를 읽을 수 없습니다.");
            int len = BitConverter.ToInt32(buf, pos);
            pos += 4;
            if (len == 0) return String.Empty;
            if (len > 0)
            {
                if (len > buf.Length - pos || buf[pos + len - 1] != 0)
                    throw new IOException("세이브 문자열 종료 바이트가 올바르지 않습니다.");
                string s = Encoding.UTF8.GetString(buf, pos, len - 1);
                pos += len;
                return s;
            }
            long chars = -(long)len;
            if (chars <= 0 || chars > int.MaxValue / 2)
                throw new IOException("세이브 유니코드 문자열 길이가 올바르지 않습니다.");
            int bytes = (int)chars * 2;
            if (bytes > buf.Length - pos || buf[pos + bytes - 2] != 0 || buf[pos + bytes - 1] != 0)
                throw new IOException("세이브 유니코드 문자열 종료 바이트가 올바르지 않습니다.");
            string u = Encoding.Unicode.GetString(buf, pos, bytes - 2);
            pos += bytes;
            return u;
        }

        private static readonly FieldInfo DeflateInflaterField =
            typeof(DeflateStream).GetField("inflater", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? typeof(DeflateStream).GetField("_inflater", BindingFlags.Instance | BindingFlags.NonPublic);

        private static bool IsDeflateStreamFinished(DeflateStream ds)
        {
            if (ds == null || DeflateInflaterField == null) return false;
            object inf = DeflateInflaterField.GetValue(ds);
            if (inf == null) return false;
            MethodInfo mi = inf.GetType().GetMethod(
                "Finished",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
                null,
                Type.EmptyTypes,
                null);
            if (mi == null) return false;
            object res = mi.Invoke(inf, null);
            return res is bool && (bool)res;
        }

        private sealed class SingleByteSliceStream : Stream
        {
            private readonly byte[] _buf;
            private readonly int _endOffset;
            private int _pos;

            public SingleByteSliceStream(byte[] buffer, int offset, int count)
            {
                _buf = buffer;
                _pos = offset;
                _endOffset = offset + count;
            }

            public bool IsFullyConsumed
            {
                get { return _pos == _endOffset; }
            }

            public override bool CanRead { get { return true; } }
            public override bool CanSeek { get { return false; } }
            public override bool CanWrite { get { return false; } }
            public override long Length { get { throw new NotSupportedException(); } }
            public override long Position
            {
                get { throw new NotSupportedException(); }
                set { throw new NotSupportedException(); }
            }

            public override int Read(byte[] buffer, int offset, int count)
            {
                if (count <= 0 || _pos >= _endOffset) return 0;
                buffer[offset] = _buf[_pos++];
                return 1;
            }

            public override int ReadByte()
            {
                if (_pos >= _endOffset) return -1;
                return _buf[_pos++];
            }

            public override void Flush() { }
            public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
            public override void SetLength(long value) { throw new NotSupportedException(); }
            public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
        }
    }
}
