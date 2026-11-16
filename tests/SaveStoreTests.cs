using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace WanderingSwordSaveEditor
{
    public static class SaveStoreTests
    {
        private static readonly byte[] A = Encoding.UTF8.GetBytes("alpha");
        private static readonly byte[] B = Encoding.UTF8.GetBytes("bravo-payload");
        private static readonly byte[] C = Encoding.UTF8.GetBytes("charlie-payload-2");

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateHardLink(string lpFileName, string lpExistingFileName, IntPtr lpSecurityAttributes);

        private sealed class FaultStream : MemoryStream
        {
            private readonly bool persistent;
            private int writes;

            public FaultStream(byte[] initial, bool persistentFault)
                : base()
            {
                base.Write(initial, 0, initial.Length);
                Position = 0;
                persistent = persistentFault;
                writes = 0;
            }

            public override void Write(byte[] buffer, int offset, int count)
            {
                if (persistent || writes == 0)
                {
                    writes++;
                    if (count > 0) base.Write(buffer, offset, 1);
                    throw new IOException("injected write fault");
                }
                writes++;
                base.Write(buffer, offset, count);
            }
        }

        public static int Main(string[] args)
        {
            Check(args != null && args.Length == 1, "usage: SaveStoreTests <new-fixture-dir>");
            string root = Path.GetFullPath(args[0]);
            Check(!Directory.Exists(root) && !File.Exists(root), "fixture directory already exists");
            Directory.CreateDirectory(root);
            try
            {
                Case1_ReplacePreservesBackups(root);
                Case2_StaleHash(root);
                Case3_LocksAndReadOnly(root);
                Case4_EmptyAndMissing(root);
                Case5_WriteNewFault(root);
                Case6_InvalidExtensionsAdsReserved(root);
                Case7_HardLinks(root);
                Case8_UpdateRollback();
                Case9_UpdateRollbackFailure();
                Case10_CopyBackupAndPending(root);
                Case11_ValidateSaveBytes();
                Console.WriteLine("ALL PASS");
                return 0;
            }
            finally
            {
                try { if (Directory.Exists(root)) Directory.Delete(root, true); }
                catch { }
            }
        }

        private static void Check(bool ok, string why)
        {
            if (!ok) throw new Exception("ASSERT: " + why);
            Console.WriteLine("PASS " + why);
        }

        private static void Reject(Action action, string why)
        {
            try
            {
                action();
            }
            catch (IOException)
            {
                Console.WriteLine("PASS " + why);
                return;
            }
            catch (UnauthorizedAccessException)
            {
                Console.WriteLine("PASS " + why);
                return;
            }
            throw new Exception("EXPECTED REJECTION: " + why);
        }

        private static void Case1_ReplacePreservesBackups(string root)
        {
            string p = Path.Combine(root, "case1.sav");
            SaveStore.WriteNew(p, A);
            string first = SaveStore.ReplaceWithBackup(p, SaveStore.Hash(A), B);
            string second = SaveStore.ReplaceWithBackup(p, SaveStore.Hash(B), C);
            Check(File.Exists(first) && File.Exists(second), "case1 backups exist");
            Check(File.ReadAllBytes(first).SequenceEqual(A), "case1 first backup bytes");
            Check(File.ReadAllBytes(second).SequenceEqual(B), "case1 second backup bytes");
            Check(File.ReadAllBytes(p).SequenceEqual(C), "case1 target updated");
            string beforeHash = SaveStore.Hash(File.ReadAllBytes(first));
            Reject(delegate { SaveStore.WriteNew(first, C); }, "case1 existing backup immutable");
            Check(SaveStore.Hash(File.ReadAllBytes(first)) == beforeHash, "case1 first backup preserved");
        }

        private static void Case2_StaleHash(string root)
        {
            string p = Path.Combine(root, "case2.sav");
            SaveStore.WriteNew(p, A);
            Reject(delegate { SaveStore.ReplaceWithBackup(p, SaveStore.Hash(B), C); }, "case2 stale hash");
            Check(File.ReadAllBytes(p).SequenceEqual(A), "case2 target unchanged");
            Check(Directory.GetFiles(root, "case2.sav.backup-*.bak").Length == 0, "case2 no backup created");
        }

        private static void Case3_LocksAndReadOnly(string root)
        {
            string p = Path.Combine(root, "case3.sav");
            SaveStore.WriteNew(p, A);
            using (FileStream fs = new FileStream(p, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                Reject(delegate { SaveStore.Read(p); }, "case3 read lock");
                Reject(delegate { SaveStore.ReplaceWithBackup(p, SaveStore.Hash(A), B); }, "case3 replace lock");
                GC.KeepAlive(fs);
            }
            File.SetAttributes(p, FileAttributes.ReadOnly);
            try
            {
                Reject(delegate { SaveStore.ReplaceWithBackup(p, SaveStore.Hash(A), B); }, "case3 readonly replace");
                Check(File.ReadAllBytes(p).SequenceEqual(A), "case3 readonly bytes intact");
            }
            finally
            {
                File.SetAttributes(p, FileAttributes.Normal);
            }
        }

        private static void Case4_EmptyAndMissing(string root)
        {
            string p = Path.Combine(root, "case4.sav");
            Reject(delegate { SaveStore.WriteNew(p, new byte[0]); }, "case4 empty payload");
            Check(!File.Exists(p), "case4 empty no file");
            string missing = Path.Combine(root, "missing.sav");
            Reject(delegate { SaveStore.ReplaceWithBackup(missing, SaveStore.Hash(A), B); }, "case4 missing replace");
            Reject(delegate { SaveStore.Read(missing); }, "case4 missing read");
        }

        private static void Case5_WriteNewFault(string root)
        {
            string sav = Path.Combine(root, "fault.sav");
            string bak = Path.Combine(root, "fault.bak");
            Action<Stream, byte[]> writer = delegate(Stream s, byte[] d)
            {
                s.Write(d, 0, 2);
                throw new IOException("fault");
            };
            Reject(delegate { SaveStore.WriteNew(sav, A, writer); }, "case5 fault sav");
            Check(!File.Exists(sav), "case5 sav cleanup");
            Reject(delegate { SaveStore.WriteNew(bak, A, writer); }, "case5 fault bak");
            Check(!File.Exists(bak), "case5 bak cleanup");
        }

        private static void Case6_InvalidExtensionsAdsReserved(string root)
        {
            string[] bad = { "bad.txt", "bad.exe", "0.sav:evil.sav", "CON.sav", "CON.txt.sav", "NUL.sav", "COM1.sav" };
            for (int i = 0; i < bad.Length; i++)
            {
                string name = bad[i];
                string p = Path.Combine(root, name);
                Check(!SaveStore.IsSaveExtension(name), "case6 invalid ext " + name);
                Reject(delegate { SaveStore.WriteNew(p, A); }, "case6 WriteNew " + name);
                Reject(delegate { SaveStore.CopyWithBackup(Path.Combine(root, "src6.sav"), p, "", B); }, "case6 Copy " + name);
            }
        }

        private static void Case7_HardLinks(string root)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) return;
            string p = Path.Combine(root, "case7.sav");
            string link = Path.Combine(root, "case7_link.sav");
            SaveStore.WriteNew(p, A);
            Check(CreateHardLink(link, p, IntPtr.Zero), "case7 hardlink created");
            try
            {
                Reject(delegate { SaveStore.Read(link); }, "case7 read hardlink");
                Reject(delegate { SaveStore.ReplaceWithBackup(link, SaveStore.Hash(A), B); }, "case7 replace hardlink");
            }
            finally
            {
                File.Delete(link);
            }
            Check(SaveStore.Read(p).SequenceEqual(A), "case7 target readable after unlink");
        }

        private static void Case8_UpdateRollback()
        {
            using (FaultStream fs = new FaultStream(A, false))
            {
                try
                {
                    SaveStore.UpdateOrRestore(fs, A, B, "backup-8.bak");
                    Check(false, "case8 should throw");
                }
                catch (IOException ex)
                {
                    Check(ex.Message.IndexOf("backup-8.bak", StringComparison.Ordinal) >= 0, "case8 backup msg");
                }
                Check(fs.ToArray().SequenceEqual(A), "case8 stream rolled back");
            }
        }

        private static void Case9_UpdateRollbackFailure()
        {
            using (FaultStream fs = new FaultStream(A, true))
            {
                try
                {
                    SaveStore.UpdateOrRestore(fs, A, B, "backup-9.bak");
                    Check(false, "case9 should throw");
                }
                catch (IOException ex)
                {
                    Check(ex.Message.IndexOf("자동 원상복구에 실패", StringComparison.Ordinal) >= 0, "case9 rollback failure text");
                    Check(ex.Message.IndexOf("backup-9.bak", StringComparison.Ordinal) >= 0, "case9 backup ref");
                }
            }
        }

        private static void Case10_CopyBackupAndPending(string root)
        {
            string src = Path.Combine(root, "case10_src.sav");
            string dst = Path.Combine(root, "case10_dst.sav");
            SaveStore.WriteNew(src, A);
            string bak = SaveStore.CopyWithBackup(src, dst, SaveStore.Hash(A), B);
            Check(File.Exists(dst) && File.Exists(bak), "case10 dst and bak exist");
            Check(File.ReadAllBytes(dst).SequenceEqual(B), "case10 dst bytes");
            Check(File.ReadAllBytes(bak).SequenceEqual(A), "case10 bak bytes");
            Reject(delegate { SaveStore.CopyWithBackup(src, dst, SaveStore.Hash(A), C); }, "case10 duplicate dst");
            Reject(delegate { SaveStore.CopyWithBackup(src, src, SaveStore.Hash(A), C); }, "case10 same src dst");
            string retryDst = Path.Combine(root, "case10_retry.sav");
            Action<Stream, byte[]> fault = delegate(Stream s, byte[] d)
            {
                s.Write(d, 0, 1);
                throw new IOException("copy fault");
            };
            try
            {
                SaveStore.CopyWithBackup(src, retryDst, SaveStore.Hash(A), C, fault);
                Check(false, "case10 fault copy should throw");
            }
            catch (IOException ex)
            {
                Check(ex.Message.IndexOf(".original-", StringComparison.OrdinalIgnoreCase) >= 0, "case10 fault preserves original bak");
            }
            Check(!File.Exists(retryDst), "case10 no partial dst");
            Check(Directory.GetFiles(root, "*.pending-*").Length == 0, "case10 pending cleaned");
            string retryBak = SaveStore.CopyWithBackup(src, retryDst, SaveStore.Hash(A), C);
            Check(File.Exists(retryDst) && File.Exists(retryBak) && File.ReadAllBytes(retryDst).SequenceEqual(C), "case10 retry succeeds");
        }

        private static void WriteAsciiFString(BinaryWriter bw, string value)
        {
            byte[] bytes = Encoding.ASCII.GetBytes(value + "\0");
            bw.Write(bytes.Length);
            bw.Write(bytes);
        }

        private static void WriteDummyItem(BinaryWriter bw, int version)
        {
            bw.Write(new byte[28]);
            bw.Write(0);
            bw.Write(0);
            int tailInts = (version >= 6 ? 1 : 0) + (version >= 9 ? 1 : 0) + (version >= 10 ? 1 : 0);
            for (int i = 0; i < tailInts; i++) bw.Write(0);
        }

        private static void WriteDummyNpc(BinaryWriter bw, int version)
        {
            bw.Write(new byte[12]);
            for (int i = 0; i < 6; i++) bw.Write(0);
            bw.Write(0);
            bw.Write(0);
            bw.Write(0);
            WriteAsciiFString(bw, "Hero");
            bw.Write(new byte[12]);
            WriteAsciiFString(bw, "None");
            bw.Write(new byte[13]);
            if (version >= 2) bw.Write(0);
            if (version >= 4) bw.Write(0);
            if (version >= 11) bw.Write(0);
            if (version >= 12) bw.Write(0);
            if (version >= 13) bw.Write(0);
            if (version >= 14) bw.Write(0);
        }

        private static byte[] BuildInnerGvas(
            string className,
            bool includeNone,
            bool embedStringNone = false,
            bool truncateAfterProp = false,
            int saveVersion = 14,
            int postZero = 0,
            int itemCount = 0,
            int npcCount = 0,
            bool omitItemPayload = false,
            bool omitNpcPayload = false,
            bool extraTrailingByte = false)
        {
            using (MemoryStream ms = new MemoryStream())
            using (BinaryWriter bw = new BinaryWriter(ms))
            {
                bw.Write(Encoding.ASCII.GetBytes("GVAS"));
                bw.Write(new byte[18]);
                bw.Write(0);
                bw.Write(3);
                bw.Write(0);
                WriteAsciiFString(bw, className);
                if (className == "/Script/JH.JHSaveGame") bw.Write(new byte[4]);
                if (embedStringNone)
                {
                    WriteAsciiFString(bw, "MapName");
                    WriteAsciiFString(bw, "StrProperty");
                    bw.Write(9L);
                    bw.Write((byte)0);
                    WriteAsciiFString(bw, "None");
                    if (truncateAfterProp)
                    {
                        bw.Flush();
                        return ms.ToArray();
                    }
                }
                if (includeNone)
                {
                    WriteAsciiFString(bw, "None");
                }
                else
                {
                    WriteAsciiFString(bw, "Nope");
                }
                bw.Write(postZero);
                if (className == "/Script/JH.JHSaveGame")
                {
                    bw.Write(itemCount);
                    if (!omitItemPayload)
                    {
                        for (int i = 0; i < itemCount; i++) WriteDummyItem(bw, saveVersion);
                    }
                    bw.Write(npcCount);
                    if (!omitNpcPayload)
                    {
                        for (int i = 0; i < npcCount; i++) WriteDummyNpc(bw, saveVersion);
                    }
                }
                if (extraTrailingByte) bw.Write((byte)0x7F);
                bw.Flush();
                return ms.ToArray();
            }
        }

        private static byte[] WrapRawDeflateSavBytes(int saveVersion, byte[] inner, byte[] rawDeflate, byte[] extraAfterDeflate = null)
        {
            int extraLen = extraAfterDeflate == null ? 0 : extraAfterDeflate.Length;
            int compSize = 2 + rawDeflate.Length + extraLen + 4;
            uint adler = SaveStore.ComputeAdler32(inner);
            using (MemoryStream outMs = new MemoryStream())
            using (BinaryWriter bw = new BinaryWriter(outMs))
            {
                bw.Write(saveVersion);
                bw.Write(inner.Length);
                bw.Write(compSize);
                bw.Write((byte)0x78);
                bw.Write((byte)0x9C);
                bw.Write(rawDeflate);
                if (extraLen > 0) bw.Write(extraAfterDeflate);
                bw.Write((byte)(adler >> 24));
                bw.Write((byte)(adler >> 16));
                bw.Write((byte)(adler >> 8));
                bw.Write((byte)adler);
                bw.Flush();
                return outMs.ToArray();
            }
        }

        private static byte[] WrapSavBytes(int saveVersion, byte[] inner, byte[] extraAfterDeflate = null)
        {
            if (saveVersion <= 5)
            {
                using (MemoryStream plainMs = new MemoryStream())
                using (BinaryWriter bw = new BinaryWriter(plainMs))
                {
                    bw.Write(saveVersion);
                    bw.Write(inner);
                    bw.Flush();
                    return plainMs.ToArray();
                }
            }
            byte[] rawDeflate;
            using (MemoryStream defMs = new MemoryStream())
            {
                using (DeflateStream ds = new DeflateStream(defMs, CompressionMode.Compress, true))
                {
                    ds.Write(inner, 0, inner.Length);
                }
                rawDeflate = defMs.ToArray();
            }
            return WrapRawDeflateSavBytes(saveVersion, inner, rawDeflate, extraAfterDeflate);
        }

        private static void Case11_ValidateSaveBytes()
        {
            byte[] v14 = WrapSavBytes(14, BuildInnerGvas("/Script/JH.JHSaveGame", true));
            byte[] v12 = WrapSavBytes(12, BuildInnerGvas("/Script/JH.JHSaveGameConfig", true));
            byte[] v5 = WrapSavBytes(5, BuildInnerGvas("/Script/JH.JHSaveGame", true));

            SaveStore.ValidateSaveBytes(v14);
            SaveStore.ValidateSaveBytes(v12);
            SaveStore.ValidateSaveBytes(v5);
            Check(true, "case11 valid slot/config/v5 saves accepted");

            Reject(delegate { SaveStore.ValidateSaveBytes(new byte[] { 0 }); }, "case11 1-byte AA== rejected");
            Reject(delegate { SaveStore.ValidateSaveBytes(new byte[20]); }, "case11 zeroed 20B rejected");

            byte[] badComp = (byte[])v14.Clone();
            badComp[8] = 0x7F;
            Reject(delegate { SaveStore.ValidateSaveBytes(badComp); }, "case11 mismatched compSize rejected");

            byte[] badZlib = (byte[])v14.Clone();
            badZlib[12] = 0x00;
            badZlib[13] = 0x00;
            Reject(delegate { SaveStore.ValidateSaveBytes(badZlib); }, "case11 bad zlib header rejected");

            byte[] badAdler = (byte[])v14.Clone();
            badAdler[badAdler.Length - 1] ^= 0xFF;
            Reject(delegate { SaveStore.ValidateSaveBytes(badAdler); }, "case11 bad Adler32 rejected");

            byte[] badMagicInner = BuildInnerGvas("/Script/JH.JHSaveGame", true);
            badMagicInner[0] = (byte)'X';
            Reject(delegate { SaveStore.ValidateSaveBytes(WrapSavBytes(14, badMagicInner)); }, "case11 bad GVAS magic rejected");

            Reject(delegate { SaveStore.ValidateSaveBytes(WrapSavBytes(14, BuildInnerGvas("/Script/Other.Save", true))); }, "case11 unsupported class rejected");
            Reject(delegate { SaveStore.ValidateSaveBytes(WrapSavBytes(14, BuildInnerGvas("/Script/JH.JHSaveGame", false))); }, "case11 missing None rejected");

            SaveStore.ValidateSaveBytes(WrapSavBytes(14, BuildInnerGvas("/Script/JH.JHSaveGame", true, true, false)));
            SaveStore.ValidateSaveBytes(WrapSavBytes(12, BuildInnerGvas("/Script/JH.JHSaveGameConfig", true, true, false)));
            Check(true, "case11 embedded None string with real terminator accepted");

            Reject(
                delegate { SaveStore.ValidateSaveBytes(WrapSavBytes(14, BuildInnerGvas("/Script/JH.JHSaveGame", false, true, true))); },
                "case11 embedded None string without real terminator (truncated) rejected");
            Reject(
                delegate { SaveStore.ValidateSaveBytes(WrapSavBytes(14, BuildInnerGvas("/Script/JH.JHSaveGame", false, true, false))); },
                "case11 embedded None string without real terminator (dangling prop) rejected");
            Reject(
                delegate { SaveStore.ValidateSaveBytes(WrapSavBytes(12, BuildInnerGvas("/Script/JH.JHSaveGameConfig", false, true, true))); },
                "case11 config embedded None string without real terminator rejected");

            SaveStore.ValidateSaveBytes(WrapSavBytes(14, BuildInnerGvas("/Script/JH.JHSaveGame", true, false, false, 14, 0, 1, 1)));
            SaveStore.ValidateSaveBytes(WrapSavBytes(5, BuildInnerGvas("/Script/JH.JHSaveGame", true, false, false, 5, 0, 1, 1)));
            Check(true, "case11 valid JHSaveGame with items and npcs accepted");

            Reject(
                delegate { SaveStore.ValidateSaveBytes(WrapSavBytes(14, BuildInnerGvas("/Script/JH.JHSaveGame", true, false, false, 14, 1, 1, 1))); },
                "case11 non-zero postZero on JHSaveGame rejected");
            Reject(
                delegate { SaveStore.ValidateSaveBytes(WrapSavBytes(12, BuildInnerGvas("/Script/JH.JHSaveGameConfig", true, false, false, 12, 1, 0, 0))); },
                "case11 non-zero postZero on JHSaveGameConfig rejected");
            Reject(
                delegate { SaveStore.ValidateSaveBytes(WrapSavBytes(14, BuildInnerGvas("/Script/JH.JHSaveGame", true, false, false, 14, 0, 1, 0, true, false, false))); },
                "case11 truncated JHSaveGame item payload rejected");
            Reject(
                delegate { SaveStore.ValidateSaveBytes(WrapSavBytes(14, BuildInnerGvas("/Script/JH.JHSaveGame", true, false, false, 14, 0, 1, 1, false, true, false))); },
                "case11 truncated JHSaveGame npc payload rejected");
            Reject(
                delegate { SaveStore.ValidateSaveBytes(WrapSavBytes(14, BuildInnerGvas("/Script/JH.JHSaveGame", true, false, false, 14, 0, 1, 1, false, false, true))); },
                "case11 trailing byte after JHSaveGame npcs rejected");
            Reject(
                delegate { SaveStore.ValidateSaveBytes(WrapSavBytes(12, BuildInnerGvas("/Script/JH.JHSaveGameConfig", true, false, false, 12, 0, 0, 0, false, false, true))); },
                "case11 trailing byte after JHSaveGameConfig rejected");
            Reject(
                delegate { SaveStore.ValidateSaveBytes(WrapSavBytes(14, BuildInnerGvas("/Script/JH.JHSaveGame", true, false, false, 14, 0, 1, 1), new byte[] { 0xDE, 0xAD })); },
                "case11 trailing bytes between deflate end and Adler32 rejected");

            byte[] storedInner = BuildInnerGvas("/Script/JH.JHSaveGameConfig", true);
            ushort slen = (ushort)storedInner.Length;
            ushort snlen = (ushort)~slen;
            byte[] storedFinal = new byte[5 + storedInner.Length];
            storedFinal[0] = 0x01;
            storedFinal[1] = (byte)slen;
            storedFinal[2] = (byte)(slen >> 8);
            storedFinal[3] = (byte)snlen;
            storedFinal[4] = (byte)(snlen >> 8);
            Buffer.BlockCopy(storedInner, 0, storedFinal, 5, storedInner.Length);
            SaveStore.ValidateSaveBytes(WrapRawDeflateSavBytes(12, storedInner, storedFinal));
            Check(true, "case11 valid BFINAL=1 stored deflate block accepted");

            byte[] storedNonFinal = (byte[])storedFinal.Clone();
            storedNonFinal[0] = 0x00;
            Reject(
                delegate { SaveStore.ValidateSaveBytes(WrapRawDeflateSavBytes(12, storedInner, storedNonFinal)); },
                "case11 non-final BFINAL=0 deflate block rejected");

            byte[] validDeflated;
            using (MemoryStream dms = new MemoryStream())
            {
                using (DeflateStream cds = new DeflateStream(dms, CompressionMode.Compress, true))
                {
                    cds.Write(storedInner, 0, storedInner.Length);
                }
                validDeflated = dms.ToArray();
            }
            byte[] choppedDeflated = new byte[validDeflated.Length - 1];
            Buffer.BlockCopy(validDeflated, 0, choppedDeflated, 0, choppedDeflated.Length);
            Reject(
                delegate { SaveStore.ValidateSaveBytes(WrapRawDeflateSavBytes(12, storedInner, choppedDeflated)); },
                "case11 truncated deflate EOB rejected");
        }
    }
}
