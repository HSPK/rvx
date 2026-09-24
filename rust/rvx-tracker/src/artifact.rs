use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::TrackerError;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactAction {
    Log,
    Use,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ArtifactRecord {
    pub action: ArtifactAction,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub digest: String,
    pub size: u64,
    pub uri: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub metadata: Value,
}

impl ArtifactRecord {
    pub fn local(
        action: ArtifactAction,
        path: impl AsRef<Path>,
        name: String,
        kind: String,
        aliases: Vec<String>,
        metadata: Value,
    ) -> Result<Self, TrackerError> {
        validate(&name, "artifact name")?;
        validate(&kind, "artifact type")?;
        let path = path.as_ref();
        let (digest, size) = digest_path(path)?;
        Ok(Self {
            action,
            name,
            kind,
            digest,
            size,
            uri: path
                .canonicalize()
                .unwrap_or_else(|_| path.to_path_buf())
                .to_string_lossy()
                .into_owned(),
            aliases,
            metadata,
        })
    }

    pub fn reference(
        action: ArtifactAction,
        uri: String,
        name: String,
        kind: String,
        digest: String,
        aliases: Vec<String>,
        metadata: Value,
    ) -> Result<Self, TrackerError> {
        for (value, field) in [
            (&uri, "artifact URI"),
            (&name, "artifact name"),
            (&kind, "artifact type"),
            (&digest, "artifact digest"),
        ] {
            validate(value, field)?;
        }
        Ok(Self {
            action,
            name,
            kind,
            digest,
            size: 0,
            uri,
            aliases,
            metadata,
        })
    }
}

fn validate(value: &str, field: &str) -> Result<(), TrackerError> {
    if value.trim().is_empty() || value.contains('\0') || value.len() > 4096 {
        return Err(TrackerError::InvalidInput(format!(
            "{field} must contain 1..=4096 non-NUL bytes"
        )));
    }
    Ok(())
}

fn digest_path(path: &Path) -> Result<(String, u64), TrackerError> {
    if path.is_symlink() {
        return Err(TrackerError::InvalidInput(
            "artifact paths must not be symbolic links".into(),
        ));
    }
    if path.is_file() {
        return digest_file(path);
    }
    if !path.is_dir() {
        return Err(TrackerError::InvalidInput(format!(
            "artifact path does not exist: {}",
            path.display()
        )));
    }
    let mut files = Vec::new();
    collect_files(path, path, &mut files)?;
    files.sort();
    let mut digest = Sha256::new();
    let mut size = 0u64;
    for relative in files {
        let full = path.join(&relative);
        let (file_digest, file_size) = digest_file(&full)?;
        digest.update(relative.to_string_lossy().as_bytes());
        digest.update([0]);
        digest.update(file_digest.as_bytes());
        digest.update([0]);
        size = size.saturating_add(file_size);
    }
    Ok((format!("{:x}", digest.finalize()), size))
}

fn collect_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), TrackerError> {
    let entries = std::fs::read_dir(directory).map_err(TrackerError::Io)?;
    for entry in entries {
        let entry = entry.map_err(TrackerError::Io)?;
        let path = entry.path();
        let metadata = entry.metadata().map_err(TrackerError::Io)?;
        if metadata.file_type().is_symlink() {
            return Err(TrackerError::InvalidInput(format!(
                "artifact directory contains a symbolic link: {}",
                path.display()
            )));
        }
        if metadata.is_dir() {
            collect_files(root, &path, files)?;
        } else if metadata.is_file() {
            files.push(
                path.strip_prefix(root)
                    .map_err(|error| TrackerError::InvalidInput(error.to_string()))?
                    .to_path_buf(),
            );
        }
    }
    Ok(())
}

fn digest_file(path: &Path) -> Result<(String, u64), TrackerError> {
    let mut file = File::open(path).map_err(TrackerError::Io)?;
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(TrackerError::Io)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        size = size.saturating_add(read as u64);
    }
    Ok((format!("{:x}", digest.finalize()), size))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_digest_is_stable_and_content_sensitive() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("a"), b"one").unwrap();
        std::fs::create_dir(directory.path().join("nested")).unwrap();
        std::fs::write(directory.path().join("nested/b"), b"two").unwrap();
        let first = digest_path(directory.path()).unwrap();
        let second = digest_path(directory.path()).unwrap();
        assert_eq!(first, second);
        std::fs::write(directory.path().join("a"), b"changed").unwrap();
        assert_ne!(first, digest_path(directory.path()).unwrap());
    }
}
