use std::fs::File;
#[cfg(test)]
use std::fs::OpenOptions;
#[cfg(test)]
use std::io::Write;
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crc32fast::Hasher;
#[cfg(test)]
use parking_lot::Mutex;
use rvx_core::MetricBatch;

use crate::{EngineError, Result};

const HEADER_BYTES: usize = 8;
const MAX_RECORD_BYTES: usize = 128 * 1024 * 1024;

pub struct MetricWal {
    path: PathBuf,
    #[cfg(test)]
    sealed_directory: PathBuf,
    #[cfg(test)]
    file: Mutex<Option<File>>,
}

impl MetricWal {
    /// Read existing archives without creating files or repairing/truncating the original WAL.
    #[cfg(not(test))]
    pub fn open_read_only(path: &Path) -> Result<(Self, Vec<MetricBatch>)> {
        let mut records = if path.exists() {
            recover(&mut File::open(path)?, false)?
        } else {
            Vec::new()
        };
        let sealed = path.with_file_name("wal-sealed");
        if sealed.exists() {
            for path in sealed_paths(&sealed)? {
                records.extend(recover(&mut File::open(path)?, false)?);
            }
        }
        Ok((
            Self {
                path: path.to_path_buf(),
            },
            records,
        ))
    }

    #[cfg(test)]
    pub fn open(path: &Path) -> Result<(Self, Vec<MetricBatch>)> {
        let sealed_directory = path.with_file_name("wal-sealed");
        std::fs::create_dir_all(&sealed_directory)?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        let mut records = recover(&mut file, true)?;
        for sealed in sealed_paths(&sealed_directory)? {
            records.extend(Self::read_records(&sealed)?);
        }
        file.seek(SeekFrom::End(0))?;
        Ok((
            Self {
                path: path.to_path_buf(),
                sealed_directory,
                file: Mutex::new(Some(file)),
            },
            records,
        ))
    }

    #[cfg(test)]
    pub fn append(&self, batch: &MetricBatch) -> Result<()> {
        let payload = serde_json::to_vec(batch)?;
        if payload.len() > MAX_RECORD_BYTES {
            return Err(EngineError::InvalidInput(
                "WAL record exceeds maximum size".into(),
            ));
        }
        let length = u32::try_from(payload.len())
            .map_err(|_| EngineError::InvalidInput("WAL record is too large".into()))?;
        let checksum = crc32fast::hash(&payload);
        let mut guard = self.file.lock();
        let file = guard
            .as_mut()
            .ok_or_else(|| EngineError::InvalidInput("WAL is rotating".into()))?;
        file.write_all(&length.to_le_bytes())?;
        file.write_all(&checksum.to_le_bytes())?;
        file.write_all(&payload)?;
        file.flush()?;
        file.sync_data()?;
        Ok(())
    }

    pub fn size(&self) -> Result<u64> {
        match std::fs::metadata(&self.path) {
            Ok(metadata) => Ok(metadata.len()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(0),
            Err(error) => Err(error.into()),
        }
    }

    #[cfg(test)]
    pub fn rotate(&self) -> Result<Option<PathBuf>> {
        let mut guard = self.file.lock();
        let mut file = guard
            .take()
            .ok_or_else(|| EngineError::InvalidInput("WAL is rotating".into()))?;
        file.flush()?;
        file.sync_data()?;
        if file.metadata()?.len() == 0 {
            *guard = Some(file);
            return Ok(None);
        }
        drop(file);
        let sealed = self.sealed_directory.join(format!(
            "segment-{}-{}-{}.wal",
            rvx_core::now_ns(),
            std::process::id(),
            rvx_core::new_id("wal")
        ));
        std::fs::rename(&self.path, &sealed)?;
        *guard = Some(
            OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(&self.path)?,
        );
        Ok(Some(sealed))
    }

    #[cfg(test)]
    pub fn sealed_paths(&self) -> Result<Vec<PathBuf>> {
        sealed_paths(&self.sealed_directory)
    }

    #[cfg(test)]
    pub fn read_records(path: &Path) -> Result<Vec<MetricBatch>> {
        let mut file = OpenOptions::new().read(true).write(true).open(path)?;
        recover(&mut file, true)
    }
}

fn sealed_paths(directory: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = std::fs::read_dir(directory)?
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .filter(|path| path.extension().is_some_and(|value| value == "wal"))
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn recover(file: &mut File, repair: bool) -> Result<Vec<MetricBatch>> {
    file.seek(SeekFrom::Start(0))?;
    let mut records = Vec::new();
    let mut valid_length = 0_u64;
    loop {
        let mut header = [0_u8; HEADER_BYTES];
        match file.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => {
                if repair {
                    file.set_len(valid_length)?;
                }
                break;
            }
            Err(error) => return Err(error.into()),
        }
        let length = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
        let expected = u32::from_le_bytes(header[4..].try_into().unwrap());
        if length > MAX_RECORD_BYTES {
            return Err(EngineError::CorruptWal(format!(
                "record length {length} exceeds limit"
            )));
        }
        let mut payload = vec![0_u8; length];
        if let Err(error) = file.read_exact(&mut payload) {
            if error.kind() == ErrorKind::UnexpectedEof {
                if repair {
                    file.set_len(valid_length)?;
                }
                break;
            }
            return Err(error.into());
        }
        let mut hasher = Hasher::new();
        hasher.update(&payload);
        let actual = hasher.finalize();
        if actual != expected {
            return Err(EngineError::CorruptWal(format!(
                "checksum mismatch at byte {valid_length}"
            )));
        }
        records.push(serde_json::from_slice(&payload)?);
        valid_length += (HEADER_BYTES + length) as u64;
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::test_directory as tempdir;
    use rvx_core::MetricPoint;

    use super::*;

    fn batch() -> MetricBatch {
        MetricBatch {
            run_id: "run".into(),
            source_id: "source".into(),
            source_session_id: "session".into(),
            oldest_sequence: 1,
            next_sequence: 2,
            dropped_before: None,
            points: vec![MetricPoint {
                source_session_id: "session".into(),
                sequence: 1,
                event_time_ns: 1,
                ingest_time_ns: 2,
                axes: BTreeMap::new(),
                values: BTreeMap::new(),
            }],
        }
    }

    #[test]
    fn truncates_partial_tail_and_replays_complete_records() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("metrics.wal");
        let (wal, _) = MetricWal::open(&path).unwrap();
        wal.append(&batch()).unwrap();
        drop(wal);
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&[9, 0, 0])
            .unwrap();

        let (_, records) = MetricWal::open(&path).unwrap();

        assert_eq!(records, vec![batch()]);
    }
}
