//! Windows workload containment.
//!
//! A kill-on-close Job Object per workload: `create` makes the job, `adopt_process`
//! places a freshly spawned child (before it can run descendants) into it, and the
//! kernel sweeps the whole tree — kill, terminate, and startup recovery are all
//! handle-driven, so leftover jobs die with the previous core process. The sandbox
//! is the security boundary (the `agent_sudo` container posture on Linux); the
//! agent-account identity drop arrives with a later phase.

use crate::workspace::storage::Policy;
use std::{
    io,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::{process::Command, sync::watch};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicProcessIdList,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject,
    },
};

pub struct Workload {
    job: Job,
    adopted: AtomicBool,
    frozen: watch::Sender<bool>,
}

/// A Windows kernel handle. Handle values are process-wide, not thread-bound, so
/// sharing one across tasks is safe; the newtype restores `Send`/`Sync`.
struct Job(HANDLE);
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Workload {
    pub fn create(_policy: &Policy) -> io::Result<Self> {
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() || job == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set == 0 {
            unsafe { CloseHandle(job) };
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            job: Job(job),
            adopted: AtomicBool::new(false),
            frozen: watch::channel(false).0,
        })
    }

    /// Identity drop comes with the agent-account phase; the sandbox is the boundary.
    pub fn attach(&self, _command: &mut Command, policy: &Policy) -> io::Result<()> {
        if policy.agent_uid == 0 || policy.agent_gid == 0 {
            return Err(io::Error::other("agent identity must be unprivileged"));
        }
        self.adopted.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// Places a freshly spawned child in the job. Run it on the same stack right
    /// after `spawn`, before the child can create descendants that would escape.
    pub fn adopt_process(&self, child: &std::process::Child) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        self.adopt_raw(child.as_raw_handle())
    }

    pub fn adopt_raw(&self, raw: std::os::windows::io::RawHandle) -> io::Result<()> {
        if self.adopted.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        if unsafe { AssignProcessToJobObject(self.job.0, raw as HANDLE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn paused(&self) -> watch::Receiver<bool> {
        self.frozen.subscribe()
    }

    /// Pause is a disk-space rescue on Linux; Windows suspends only whole processes.
    pub async fn freeze(&self, frozen: bool) -> io::Result<()> {
        if !frozen {
            self.frozen.send_replace(false);
            return Ok(());
        }
        Err(io::Error::other(
            "pausing workloads requires Linux on this build",
        ))
    }

    /// Idle sleep counts the workload's processes beyond the launch set.
    pub fn process_count(&self) -> Option<usize> {
        self.pids().ok().map(|pids| pids.len())
    }

    fn pids(&self) -> io::Result<Vec<usize>> {
        // JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD_PTRs, then one entry per process.
        let mut buf = [0u8; 16 + core::mem::size_of::<usize>() * 256];
        let mut returned = 0u32;
        let query = unsafe {
            QueryInformationJobObject(
                self.job.0,
                JobObjectBasicProcessIdList,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                buf.len() as u32,
                &mut returned,
            )
        };
        if query == 0 {
            return Err(io::Error::last_os_error());
        }
        let numbers = usize::from_ne_bytes(buf[..8].try_into().unwrap());
        // `_total` may exceed the buffer's capacity; `numbers` caps at what was stored.
        let entries = numbers.min(256);
        let mut pids = Vec::with_capacity(entries);
        for index in 0..entries {
            let start = 16 + index * core::mem::size_of::<usize>();
            let pid = usize::from_ne_bytes(buf[start..start + 8].try_into().unwrap());
            if pid != 0 {
                pids.push(pid);
            }
        }
        Ok(pids)
    }

    pub fn kill_top_writer(&self, _harness: u32) -> io::Result<Option<String>> {
        Err(io::Error::other(
            "per-process write accounting requires Linux on this build",
        ))
    }

    pub fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.job.0, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub async fn stop(&self) -> io::Result<()> {
        self.terminate()
    }

    /// At startup: leftover jobs from an earlier core died with its process, because
    /// every job closes on its last handle. Nothing to sweep.
    pub async fn clear(_policy: &Policy) -> io::Result<()> {
        // An acquired-but-unassigned job handle counts; adopt() proves the first.
        Ok(())
    }
}

impl Drop for Workload {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.job.0) };
    }
}

/// Windows has no identity drop yet: agent processes run as the service account,
/// so the sandbox is the security boundary. Protected mode only reaches here from
/// workspace workers spawned under an existing workload.
pub(crate) fn as_agent(
    _command: &mut Command,
    _uid: u32,
    _gid: u32,
    _group: Option<&std::path::Path>,
    _no_new_privs: bool,
) -> io::Result<()> {
    Ok(())
}
