use super::*;

fn write_response(outcome: WriteOutcome) -> Response {
    match outcome {
        WriteOutcome::Created { id, generation } => {
            created_section(StatusCode::CREATED, id, generation)
        }
        WriteOutcome::Existing { id, generation } => {
            created_section(StatusCode::OK, id, generation)
        }
        WriteOutcome::Layout => StatusCode::NO_CONTENT.into_response(),
    }
}

fn created_section(status: StatusCode, id: Uuid, generation: i64) -> Response {
    (
        status,
        Json(CreatedSection {
            id,
            generation: generation.to_string(),
        }),
    )
        .into_response()
}

#[utoipa::path(post, path="/api/v1/orgs/{org}/me/sections",request_body=CreateSection,
    params(("org"=Uuid,Path)), security(("cookie"=[]),("bearer"=[])),
    responses((status=201,description="Section appended",body=CreatedSection),
    (status=200,description="Canonical retry with current generation",body=CreatedSection),
    (status=400,description="invalid input or invalid_section_name",body=ErrorBody), (status=401,description="invalid credentials",body=ErrorBody),
    (status=404,description="organization_unavailable",body=ErrorBody),
    (status=409,description="section_id_conflict, section_deleted or section_limit",body=ErrorBody),
    (status=413,description="Body exceeds 16 KiB",body=ErrorBody), (status=415,description="expected application/json",body=ErrorBody),
    (status=500,description="internal error",body=ErrorBody),
    (status=503,description="lock_contention on a lock timeout (no Retry-After)",body=ErrorBody)))]
pub(crate) async fn create(
    State(state): State<AppState>,
    Extension(activity): Extension<activity::Activity>,
    owner: Owner,
    ApiJson(input): ApiJson<CreateSection>,
) -> Result<Response, ApiError> {
    validate_name(&input.name)?;
    write(&state, activity, owner, Mutation::Create(input))
        .await
        .map(write_response)
}

#[utoipa::path(patch, path="/api/v1/orgs/{org}/me/sections/{id}",request_body=RenameSection,
    params(("org"=Uuid,Path),("id"=Uuid,Path)), security(("cookie"=[]),("bearer"=[])),
    responses((status=204,description="Name set or already current"),
    (status=400,description="invalid input or invalid_section_name",body=ErrorBody), (status=401,description="invalid credentials",body=ErrorBody),
    (status=404,description="organization_unavailable or section_not_found",body=ErrorBody),
    (status=413,description="Body exceeds 16 KiB",body=ErrorBody), (status=415,description="expected application/json",body=ErrorBody),
    (status=500,description="internal error",body=ErrorBody),
    (status=503,description="lock_contention on a lock timeout (no Retry-After)",body=ErrorBody)))]
pub(crate) async fn rename(
    State(state): State<AppState>,
    Extension(activity): Extension<activity::Activity>,
    owner: Owner,
    TargetId(id): TargetId,
    ApiJson(input): ApiJson<RenameSection>,
) -> Result<Response, ApiError> {
    validate_name(&input.name)?;
    write(&state, activity, owner, Mutation::Rename(id, input))
        .await
        .map(write_response)
}

#[utoipa::path(delete, path="/api/v1/orgs/{org}/me/sections/{id}",
    params(("org"=Uuid,Path),("id"=Uuid,Path)), security(("cookie"=[]),("bearer"=[])),
    responses((status=204,description="Owned section deleted or unavailable"),
    (status=400,description="invalid input",body=ErrorBody), (status=401,description="invalid credentials",body=ErrorBody),
    (status=404,description="organization_unavailable",body=ErrorBody), (status=500,description="internal error",body=ErrorBody),
    (status=503,description="lock_contention on a lock timeout or when the restart bound is exhausted (no Retry-After)",body=ErrorBody)))]
pub(crate) async fn delete(
    State(state): State<AppState>,
    Extension(activity): Extension<activity::Activity>,
    owner: Owner,
    TargetId(id): TargetId,
) -> Result<Response, ApiError> {
    write(&state, activity, owner, Mutation::Delete(id))
        .await
        .map(write_response)
}

#[utoipa::path(put, path="/api/v1/orgs/{org}/me/sections/order",request_body=SectionOrder,
    params(("org"=Uuid,Path)), security(("cookie"=[]),("bearer"=[])),
    responses((status=204,description="Complete section order set or already current"),
    (status=400,description="invalid input or invalid_section_order",body=ErrorBody), (status=401,description="invalid credentials",body=ErrorBody),
    (status=404,description="organization_unavailable or section_not_found",body=ErrorBody),
    (status=409,description="section_layout_changed",body=ErrorBody),
    (status=413,description="Body exceeds 16 KiB",body=ErrorBody), (status=415,description="expected application/json",body=ErrorBody),
    (status=500,description="internal error",body=ErrorBody),
    (status=503,description="lock_contention on a lock timeout (no Retry-After)",body=ErrorBody)))]
pub(crate) async fn section_order(
    State(state): State<AppState>,
    Extension(activity): Extension<activity::Activity>,
    owner: Owner,
    ApiJson(input): ApiJson<SectionOrder>,
) -> Result<Response, ApiError> {
    validate_order(&input.section_ids, MAX_SECTIONS)?;
    write(&state, activity, owner, Mutation::SectionOrder(input))
        .await
        .map(write_response)
}

#[utoipa::path(put, path="/api/v1/orgs/{org}/me/channel-sections/{channel_id}",request_body=MoveChannel,
    params(("org"=Uuid,Path),("channel_id"=Uuid,Path)), security(("cookie"=[]),("bearer"=[])),
    responses((status=204,description="Channel moved or already in the requested group"),
    (status=400,description="invalid input",body=ErrorBody), (status=401,description="invalid credentials",body=ErrorBody),
    (status=404,description="organization_unavailable, channel not found or section_not_found",body=ErrorBody),
    (status=409,description="channel_archived",body=ErrorBody),
    (status=413,description="Body exceeds 16 KiB",body=ErrorBody), (status=415,description="expected application/json",body=ErrorBody),
    (status=500,description="internal error",body=ErrorBody),
    (status=503,description="lock_contention on a lock timeout (no Retry-After)",body=ErrorBody)))]
pub(crate) async fn move_channel(
    State(state): State<AppState>,
    Extension(activity): Extension<activity::Activity>,
    owner: Owner,
    TargetId(channel): TargetId,
    ApiJson(input): ApiJson<MoveChannel>,
) -> Result<Response, ApiError> {
    write(&state, activity, owner, Mutation::Move(channel, input))
        .await
        .map(write_response)
}

#[utoipa::path(put, path="/api/v1/orgs/{org}/me/section-channel-order",request_body=ChannelOrder,
    params(("org"=Uuid,Path)), security(("cookie"=[]),("bearer"=[])),
    responses((status=204,description="Complete accessible active Channel order set or already current"),
    (status=400,description="invalid input or invalid_section_order",body=ErrorBody), (status=401,description="invalid credentials",body=ErrorBody),
    (status=404,description="organization_unavailable, section_not_found or channel not found",body=ErrorBody),
    (status=409,description="channel_archived or section_layout_changed",body=ErrorBody),
    (status=413,description="Body exceeds 1 MiB",body=ErrorBody), (status=415,description="expected application/json",body=ErrorBody),
    (status=500,description="internal error",body=ErrorBody),
    (status=503,description="lock_contention on a lock timeout (no Retry-After)",body=ErrorBody)))]
pub(crate) async fn channel_order(
    State(state): State<AppState>,
    Extension(activity): Extension<activity::Activity>,
    owner: Owner,
    ApiJson(input): ApiJson<ChannelOrder>,
) -> Result<Response, ApiError> {
    validate_order(&input.channel_ids, MAX_CHANNELS)?;
    write(&state, activity, owner, Mutation::ChannelOrder(input))
        .await
        .map(write_response)
}
