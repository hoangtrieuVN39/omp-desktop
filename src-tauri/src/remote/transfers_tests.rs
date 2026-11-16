use super::*;
use base64::Engine as _;

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[test]
fn an_upload_in_order_is_taken_once_by_its_own_device() {
    let t = Transfers::default();
    let now = Instant::now();
    t.begin("dev", "img1", "image/png", 6, now).unwrap();
    t.chunk("dev", "img1", 0, &b64(b"abc")).unwrap();
    t.chunk("dev", "img1", 1, &b64(b"def")).unwrap();
    t.end("dev", "img1").unwrap();
    assert_eq!(
        t.take_upload("other", "img1", now),
        None,
        "bound to its device"
    );
    let image = t.take_upload("dev", "img1", now).unwrap();
    assert_eq!(image.mime_type, "image/png");
    assert_eq!(image.data, b64(b"abcdef"));
    assert_eq!(t.take_upload("dev", "img1", now), None, "taken once");
}

#[test]
fn uploads_refuse_bad_types_sizes_ids_and_order() {
    let t = Transfers::default();
    let now = Instant::now();
    assert_eq!(
        t.begin("d", "x", "text/html", 10, now),
        Err(UploadError::UnsupportedType)
    );
    assert_eq!(
        t.begin("d", "x", "image/png", MAX_UPLOAD_BYTES + 1, now),
        Err(UploadError::TooLarge)
    );
    assert_eq!(
        t.begin("d", "x", "image/png", 0, now),
        Err(UploadError::TooLarge)
    );
    assert_eq!(
        t.begin("d", "../x", "image/png", 3, now),
        Err(UploadError::BadRequest)
    );
    t.begin("d", "x", "image/png", 3, now).unwrap();
    assert_eq!(
        t.chunk("d", "x", 1, &b64(b"a")),
        Err(UploadError::OutOfOrder)
    );
    assert_eq!(t.chunk("d", "x", 0, "%%%"), Err(UploadError::BadRequest));
    assert_eq!(
        t.chunk("d", "x", 0, &b64(&vec![0; MAX_CHUNK_BYTES + 1])),
        Err(UploadError::BadRequest)
    );
    assert_eq!(
        t.chunk("d", "x", 0, &b64(b"abcd")),
        Err(UploadError::TooLarge)
    );
    assert_eq!(
        t.chunk("d", "x", 0, &b64(b"a")),
        Err(UploadError::Unknown),
        "overflow drops it"
    );
    assert_eq!(
        t.chunk("d", "nope", 0, &b64(b"a")),
        Err(UploadError::Unknown)
    );
}

#[test]
fn an_incomplete_upload_is_dropped_at_end_and_never_taken() {
    let t = Transfers::default();
    let now = Instant::now();
    t.begin("d", "x", "image/jpeg", 4, now).unwrap();
    t.chunk("d", "x", 0, &b64(b"ab")).unwrap();
    assert_eq!(t.take_upload("d", "x", now), None, "not finished");
    assert_eq!(t.end("d", "x"), Err(UploadError::Incomplete));
    assert_eq!(t.end("d", "x"), Err(UploadError::Unknown));
}

#[test]
fn uploads_are_capped_per_device_and_expire() {
    let t = Transfers::default();
    let now = Instant::now();
    for n in 0..MAX_UPLOADS_PER_DEVICE {
        t.begin("d", &format!("u{n}"), "image/png", 1, now).unwrap();
    }
    assert_eq!(
        t.begin("d", "extra", "image/png", 1, now),
        Err(UploadError::TooMany)
    );
    t.begin("other", "u0", "image/png", 1, now).unwrap();
    // Restarting a known id is not a new slot.
    t.begin("d", "u0", "image/png", 1, now).unwrap();
    let later = now + UPLOAD_TTL;
    t.begin("d", "fresh", "image/png", 1, later).unwrap();
    t.chunk("d", "fresh", 0, &b64(b"z")).unwrap();
    t.end("d", "fresh").unwrap();
    assert!(t.take_upload("d", "fresh", later).is_some());
    assert_eq!(
        t.chunk("d", "u1", 0, &b64(b"z")),
        Err(UploadError::Unknown),
        "expired"
    );
}

#[test]
fn a_download_is_served_once_to_its_device_only() {
    let dir = crate::test_support::tempdir("remote-transfers", "download");
    let path = dir.join("session \"x\".html");
    std::fs::write(&path, b"<html>hi</html>").unwrap();
    let t = Transfers::default();
    let now = Instant::now();
    let id = t.offer("dev", path, now).unwrap();
    assert!(t.serve("other", &id, now).is_none(), "another device");
    let served = t.serve("dev", &id, now).unwrap();
    assert_eq!(served.bytes, b"<html>hi</html>");
    assert_eq!(
        served.name, "session x.html",
        "header-unsafe characters dropped"
    );
    assert!(t.serve("dev", &id, now).is_none(), "single use");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn downloads_expire_evict_the_oldest_and_refuse_non_files() {
    let dir = crate::test_support::tempdir("remote-transfers", "download-limits");
    let path = dir.join("a.html");
    std::fs::write(&path, b"x").unwrap();
    let t = Transfers::default();
    let now = Instant::now();
    assert!(t.offer("dev", dir.clone(), now).is_err(), "a folder");
    assert!(t.offer("dev", dir.join("missing"), now).is_err());
    let first = t.offer("dev", path.clone(), now).unwrap();
    let ids: Vec<String> = (1..=MAX_DOWNLOADS_PER_DEVICE)
        .map(|n| {
            t.offer("dev", path.clone(), now + Duration::from_secs(n as u64))
                .unwrap()
        })
        .collect();
    assert!(t.serve("dev", &first, now).is_none(), "oldest evicted");
    let expired = now + DOWNLOAD_TTL + Duration::from_secs(10);
    assert!(t.serve("dev", &ids[0], expired).is_none(), "expired");
    std::fs::remove_dir_all(dir).unwrap();
}
