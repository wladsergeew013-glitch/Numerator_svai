// Built against nanoCAD 26 NRX and Model Studio's public parametric SDK.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <afxwin.h>
#include <windows.h>
#include <unknwn.h>
#include <oleauto.h>
#pragma warning(push, 0)
#include "arxHeaders.h"
#include "dbdynblk.h"
#include "UnitsCS/CSParametricInterfaces.h"
#pragma warning(pop)
#include <chrono>
#include <algorithm>
#include <cmath>
#include <cwctype>
#include <fstream>
#include <iomanip>
#include <map>
#include <memory>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include "SelectionSnapshot.h"

namespace {
std::string Utf8(const std::wstring& text) {
    if (text.empty()) return {};
    int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), (int)text.size(), nullptr, 0, nullptr, nullptr);
    if (!count) throw std::runtime_error("Invalid Unicode string");
    std::string result(count, 0);
    WideCharToMultiByte(CP_UTF8, 0, text.data(), (int)text.size(), result.data(), count, nullptr, nullptr);
    return result;
}
std::wstring Wide(const std::string& text) {
    if (text.empty()) return {};
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), (int)text.size(), nullptr, 0);
    if (!count) throw std::runtime_error("Invalid UTF-8");
    std::wstring result(count, 0);
    MultiByteToWideChar(CP_UTF8, 0, text.data(), (int)text.size(), result.data(), count);
    return result;
}
std::string Json(const std::string& text) {
    std::ostringstream out; out << '"';
    for (unsigned char c : text) {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (c < 32) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << (int)c << std::dec;
        else out << c;
    }
    out << '"'; return out.str();
}
std::string Json(const std::wstring& text) { return Json(Utf8(text)); }
std::string Decode(const std::string& hex) {
    if (hex.size() % 2) throw std::runtime_error("Invalid request encoding");
    std::string result;
    for (size_t i = 0; i < hex.size(); i += 2) {
        const auto part = hex.substr(i, 2);
        if (part.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) throw std::runtime_error("Invalid request encoding");
        result.push_back((char)std::stoi(part, nullptr, 16));
    }
    return result;
}
void Require(Acad::ErrorStatus status, const char* operation) {
    if (status != Acad::eOk) throw std::runtime_error(std::string(operation) + ": SDK status " + std::to_string((int)status));
}
std::wstring ModuleFile() {
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(&ModuleFile), &module)) throw std::runtime_error("Cannot identify SDK bridge module");
    wchar_t path[32768] = {};
    if (!GetModuleFileNameW(module, path, 32768)) throw std::runtime_error("Cannot identify SDK bridge path");
    return path;
}
bool SamePath(std::wstring first, std::wstring second) {
    std::replace(first.begin(), first.end(), L'/', L'\\');
    std::replace(second.begin(), second.end(), L'/', L'\\');
    return CompareStringOrdinal(first.c_str(), -1, second.c_str(), -1, TRUE) == CSTR_EQUAL;
}
std::wstring GuidKey(const std::wstring& value) {
    std::wstring result;
    for (auto ch : value) if (iswxdigit(ch)) result += (wchar_t)towupper(ch);
    return result.size() == 32 && result.find_first_not_of(L'0') != std::wstring::npos ? result : L"";
}
std::wstring FileTitle(std::wstring value) {
    const auto slash = value.find_last_of(L"/\\");
    if (slash != std::wstring::npos) value.erase(0, slash + 1);
    if (value.size() > 4 && !_wcsicmp(value.c_str() + value.size() - 4, L".dwg")) value.resize(value.size() - 4);
    return value;
}
std::wstring Fingerprint(AcDbDatabase* db) {
    wchar_t* value = nullptr;
    const auto status = db->getFingerprintGuid(value);
    std::wstring result = status == Acad::eOk && value ? value : L"";
    if (value) acutDelString(value);
    return result;
}
std::wstring CommandName() {
    const auto path = ModuleFile();
    const auto extension = path.find_last_of(L'.');
    const auto dot = extension == std::wstring::npos ? extension : path.find_last_of(L'.', extension - 1);
    auto suffix = dot == std::wstring::npos ? L"" : path.substr(dot + 1, extension - dot - 1);
    if (suffix.size() != 12 || !std::all_of(suffix.begin(), suffix.end(), [](wchar_t ch) { return iswxdigit(ch) != 0; })) return L"PILESDK_RUN";
    std::transform(suffix.begin(), suffix.end(), suffix.begin(), [](wchar_t ch) { return (wchar_t)towupper(ch); });
    return L"PILESDK_RUN_" + suffix;
}
std::wstring commandGroup;
template<class T> struct Open {
    T* value = nullptr;
    ~Open() { if (value) value->close(); }
};
template<class T> struct Ref {
    T* value = nullptr;
    ~Ref() { if (value) value->Release(); }
};
struct BString {
    BSTR value = nullptr;
    ~BString() { SysFreeString(value); }
    std::wstring Text() const { return value ? std::wstring(value, SysStringLen(value)) : L""; }
};
struct Request {
    std::wstring path, response;
    std::map<std::string, std::string> values;
    explicit Request(const std::wstring& filename) : path(filename), response(filename + L".response.json") {
        std::ifstream input(filename, std::ios::binary);
        if (!input) throw std::runtime_error("Cannot read SDK request");
        input.seekg(0, std::ios::end);
        if (input.tellg() > 2 * 1024 * 1024) throw std::runtime_error("SDK request exceeds size limit");
        input.seekg(0);
        std::string line;
        while (std::getline(input, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            auto split = line.find('=');
            if (split == std::string::npos) throw std::runtime_error("Invalid SDK request");
            values[line.substr(0, split)] = Decode(line.substr(split + 1));
        }
        if (values["protocol"] != "1") throw std::runtime_error("Unsupported SDK bridge protocol");
        Check();
    }
    void Check() {
        const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        if (std::stoll(values.at("deadline")) < now) throw std::runtime_error("SDK request expired; no operation performed");
        if (GetFileAttributesW((path + L".cancel").c_str()) != INVALID_FILE_ATTRIBUTES) throw std::runtime_error("SDK request cancelled");
        if (!SamePath(ModuleFile(), Wide(values.at("module"))))
            throw std::runtime_error("Another SDK bridge build is already loaded. Restart nanoCAD before using the updated module.");
    }
};
void Publish(const std::wstring& path, const std::string& json) {
    const auto temporary = path + L".tmp";
    {
        std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
        stream << json; stream.flush();
        if (!stream) throw std::runtime_error("Cannot write SDK response");
    }
    if (!MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw std::runtime_error("Cannot publish SDK response");
}
MStudioParametric::IFactoryInterface* Factory() {
    HMODULE module = GetModuleHandleW(L"UnitsCS.nrx");
    if (!module) throw std::runtime_error("Model Studio UnitsCS.nrx is not loaded. Open nanoCAD with Model Studio.");
    using Entry = MStudioParametric::IFactoryInterface* (WINAPI*)(int, int);
    auto entry = reinterpret_cast<Entry>(GetProcAddress(module, "GetMStudioDataInterface"));
    if (!entry) throw std::runtime_error("Model Studio public SDK entry is unavailable");
    auto factory = entry(MSTUDIO_PARAMETRIC_API_CUR_VER_MAJOR, MSTUDIO_PARAMETRIC_API_CUR_VER_MINOR);
    if (!factory) throw std::runtime_error("Model Studio rejected the public SDK version");
    int major = 0, minor = 0; factory->GetApiVersion(major, minor);
    if (major != MSTUDIO_PARAMETRIC_API_CUR_VER_MAJOR || minor < MSTUDIO_PARAMETRIC_API_CUR_VER_MINOR)
        throw std::runtime_error("Model Studio SDK version mismatch");
    return factory;
}
std::string Position(const AcGePoint3d& point) {
    if (!std::isfinite(point.x) || !std::isfinite(point.y) || !std::isfinite(point.z))
        throw std::runtime_error("Non-finite SDK object position");
    std::ostringstream out; out.imbue(std::locale::classic());
    out << std::setprecision(17) << '[' << point.x << ',' << point.y << ',' << point.z << ']';
    return out.str();
}
std::string ReadEntity(AcDbEntity* entity) {
    AcDbHandle handle; entity->getAcDbHandle(handle);
    wchar_t handleText[32] = {}; handle.getIntoAsciiBuffer(handleText, 32);
    const std::wstring type = entity->isA()->name();
    std::ostringstream out;
    out << "{\"handle\":" << Json(std::wstring(handleText)) << ",\"objectName\":" << Json(type);
    if (auto block = AcDbBlockReference::cast(entity)) {
        Open<AcDbBlockTableRecord> record;
        AcDbDynBlockReference dynamic(block->objectId());
        auto definition = dynamic.isDynamicBlock() ? dynamic.dynamicBlockTableRecord() : block->blockTableRecord();
        Require(acdbOpenObject(record.value, definition, AcDb::kForRead), "Read block definition");
        AcString name; Require(record.value->getName(name), "Read block name");
        out << ",\"kind\":\"block\",\"name\":" << Json(std::wstring(name.kACharPtr()))
            << ",\"position\":" << Position(block->position()) << ",\"attributes\":{";
        std::unique_ptr<AcDbObjectIterator> iterator(block->attributeIterator()); bool first = true;
        for (; !iterator->done(); iterator->step()) {
            Open<AcDbAttribute> attribute;
            Require(acdbOpenObject(attribute.value, iterator->objectId(), AcDb::kForRead), "Read block attribute");
            if (!first) out << ','; first = false;
            out << Json(std::wstring(attribute.value->tag())) << ':' << Json(std::wstring(attribute.value->textString()));
        }
        out << '}';
    } else {
        // Only the SDK factory identifies Model Studio objects; no COM wrapper is created.
        HMODULE module = GetModuleHandleW(L"UnitsCS.nrx");
        std::unique_ptr<AcDbEntity> snapshot;
        Ref<MStudioParametric::IParametricEntWrapper> wrapper;
        auto status = module ? Factory()->CreateParametricWrapper(&wrapper.value, entity) : Acad::eWrongObjectType;
        if (status == Acad::eWrongObjectType) {
            out << ",\"kind\":\"other\"";
        } else {
            Require(status, "Create Model Studio SDK wrapper");
            if (!wrapper.value) throw std::runtime_error("Model Studio SDK returned an empty wrapper");
            // GetParametersRoot is non-const in the public MS SDK. Its contract
            // permits only const methods on a read-open entity. Read a detached
            // clone so that obtaining the parameter tree cannot change the DWG.
            if (!entity->isWriteEnabled()) {
                wrapper.value->Release(); wrapper.value = nullptr;
                snapshot.reset(AcDbEntity::cast(entity->clone()));
                if (!snapshot) throw std::runtime_error("Cannot create a detached Model Studio read snapshot");
                Require(Factory()->CreateParametricWrapper(&wrapper.value, snapshot.get()), "Open detached Model Studio snapshot");
                if (!wrapper.value) throw std::runtime_error("No wrapper for detached Model Studio snapshot");
            }
            Ref<MStudioData::IElement> root;
            Require(wrapper.value->GetParametersRoot(&root.value), "Read Model Studio parameters");
            if (!root.value) throw std::runtime_error("Model Studio SDK returned no parameter root");
            out << ",\"kind\":\"model_studio\",\"name\":" << Json(std::wstring(root.value->GetName()))
                << ",\"position\":" << Position(wrapper.value->GetPosition()) << ",\"parameters\":{";
            auto count = root.value->GetParamsCount();
            if (count < 0 || count > 100000) throw std::runtime_error("Invalid Model Studio parameter count");
            for (idx_t i = 0; i < count; ++i) {
                Ref<MStudioData::IParam> parameter;
                if (!root.value->GetParameter(i, &parameter.value) || !parameter.value) throw std::runtime_error("Cannot read Model Studio parameter");
                BString value; parameter.value->GetValue(&value.value);
                if (i) out << ',';
                out << Json(std::wstring(parameter.value->GetName())) << ':' << Json(value.Text());
            }
            out << '}';
        }
    }
    out << '}'; return out.str();
}
std::vector<AcDbObjectId> Objects(AcDbDatabase* db, const std::string& scope, const Request& request) {
    std::vector<AcDbObjectId> result;
    if (scope == "selection") {
        std::ifstream snapshot(request.path + L".selection", std::ios::binary);
        if (!snapshot) throw std::runtime_error("Cannot read pre-command selection snapshot");
        for (const auto& handle : ReadSelectionSnapshot(snapshot)) {
            AcDbObjectId id;
            Require(db->getAcDbObjectId(id, false, AcDbHandle(Wide(handle).c_str())), "Resolve pre-command selected object");
            result.push_back(id);
        }
    } else if (scope == "all") {
        Open<AcDbBlockTable> table; Require(db->getBlockTable(table.value, AcDb::kForRead), "Open block table");
        Open<AcDbBlockTableRecord> model;
        Require(table.value->getAt(ACDB_MODEL_SPACE, model.value, AcDb::kForRead), "Open model space");
        AcDbBlockTableRecordIterator* raw = nullptr; Require(model.value->newIterator(raw), "Enumerate model space");
        std::unique_ptr<AcDbBlockTableRecordIterator> iterator(raw);
        for (; !iterator->done(); iterator->step()) { AcDbObjectId id; Require(iterator->getEntityId(id), "Read object id"); result.push_back(id); }
    } else throw std::runtime_error("Unknown SDK scan scope");
    return result;
}
void Execute(Request& request) {
    auto db = acdbHostApplicationServices()->workingDatabase();
    if (!db) throw std::runtime_error("No active nanoCAD database");
    const wchar_t* filename = nullptr; Require(db->getFilename(filename), "Read document path");
    const auto expected = Wide(request.values.at("document"));
    const bool saved = request.values["documentSaved"] != "0";
    const auto fingerprint = Fingerprint(db), expectedGuid = GuidKey(Wide(request.values["documentGuid"]));
    if (!expectedGuid.empty() && expectedGuid != GuidKey(fingerprint)) throw std::runtime_error("Active drawing changed; SDK operation cancelled");
    if (saved) {
        if (!filename || !SamePath(filename, expected)) throw std::runtime_error("Active drawing changed; SDK operation cancelled");
    } else {
        if (GuidKey(fingerprint).empty()) throw std::runtime_error("Cannot identify unsaved DWG fingerprint");
        auto document = acDocManager->curDocument();
        const wchar_t* title = document ? document->fileName() : nullptr;
        if (expectedGuid.empty() && (!title || !SamePath(FileTitle(title), FileTitle(expected))))
            throw std::runtime_error("Active unsaved drawing changed; SDK operation cancelled");
    }
    const auto operation = request.values.at("operation");
    std::ostringstream out; out << "{\"protocol\":1,\"ok\":true,\"module\":" << Json(ModuleFile())
        << ",\"documentGuid\":" << Json(fingerprint) << ",\"document\":" << Json(saved ? std::wstring(filename) : expected);
    if (operation == "identify") {
        // Identity lookup does not enumerate or modify drawing objects.
    } else if (operation == "scan") {
        const auto scope = request.values.at("scope");
        auto ids = Objects(db, scope, request);
        if (scope == "selection") out << ",\"selectionSource\":\"pre-command\",\"selectionSnapshotCount\":" << ids.size();
        out << ",\"objects\":[";
        for (size_t i = 0; i < ids.size(); ++i) {
            request.Check(); Open<AcDbEntity> entity;
            Require(acdbOpenObject(entity.value, ids[i], AcDb::kForRead), "Open entity for SDK scan");
            if (i) out << ','; out << ReadEntity(entity.value);
        }
        out << ']';
    } else if (operation == "read" || operation == "parameter" || operation == "attribute" || operation == "pick") {
        std::string text;
        if (operation == "pick") {
            ads_name selected; ads_point point;
            if (acedEntSel(L"\nSelect pile block: ", selected, point) != RTNORM) throw std::runtime_error("Object selection cancelled");
            AcDbObjectId selectedId; Require(acdbGetObjectId(selectedId, selected), "Resolve selected object");
            AcDbHandle selectedHandle = selectedId.handle();
            wchar_t selectedText[32] = {}; selectedHandle.getIntoAsciiBuffer(selectedText, 32);
            text = Utf8(std::wstring(selectedText));
        } else text = request.values.at("handle");
        if (text.empty() || text.size() > 16 || text.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos)
            throw std::runtime_error("Invalid SDK object handle");
        AcDbObjectId id; Require(db->getAcDbObjectId(id, false, AcDbHandle(Wide(text).c_str())), "Resolve SDK object handle");
        Open<AcDbEntity> entity;
        const bool write = operation == "parameter" || operation == "attribute";
        Require(acdbOpenObject(entity.value, id, write ? AcDb::kForWrite : AcDb::kForRead), "Open SDK target");
        request.Check();
        if (operation == "parameter") {
            Ref<MStudioParametric::IParametricEntWrapper> wrapper;
            Require(Factory()->CreateParametricWrapper(&wrapper.value, entity.value), "Open Model Studio SDK target");
            if (!wrapper.value) throw std::runtime_error("Empty Model Studio SDK wrapper");
            Ref<MStudioData::IElement> root; Require(wrapper.value->GetParametersRoot(&root.value), "Read parameter root");
            if (!root.value) throw std::runtime_error("Empty Model Studio SDK parameter root");
            const auto name = Wide(request.values.at("name")), value = Wide(request.values.at("value"));
            Ref<MStudioData::IParam> parameter;
            if (!root.value->GetParameter(name.c_str(), &parameter.value) || !parameter.value) throw std::runtime_error("Target parameter does not exist");
            parameter.value->SetValue(value.c_str());
            Require(wrapper.value->UpdateData(), "Commit Model Studio SDK parameters");
        } else if (operation == "attribute") {
            auto block = AcDbBlockReference::cast(entity.value);
            if (!block) throw std::runtime_error("Target is not a block reference");
            const auto name = Wide(request.values.at("name")), value = Wide(request.values.at("value"));
            std::unique_ptr<AcDbObjectIterator> iterator(block->attributeIterator()); bool found = false;
            for (; !iterator->done(); iterator->step()) {
                Open<AcDbAttribute> attribute; Require(acdbOpenObject(attribute.value, iterator->objectId(), AcDb::kForWrite), "Open target attribute");
                if (_wcsicmp(attribute.value->tag(), name.c_str())) continue;
                attribute.value->setTextString(value.c_str()); found = true; break;
            }
            if (!found) throw std::runtime_error("Target block attribute does not exist");
        }
        if (write) { entity.value->recordGraphicsModified(true); acedUpdateDisplay(); }
        out << ",\"object\":" << ReadEntity(entity.value);
    } else throw std::runtime_error("Unknown SDK operation");
    out << '}'; Publish(request.response, out.str());
}
void Run(const wchar_t* path) {
    try { Request request(path); Execute(request); }
    catch (const std::exception& error) {
        try { Publish(std::wstring(path) + L".response.json", "{\"protocol\":1,\"ok\":false,\"error\":" + Json(std::string(error.what())) + "}"); } catch (...) {}
        acutPrintf(L"\nPile Numbering SDK bridge failed. See the application log.\n");
    }
}
void Command() { wchar_t path[4096] = {}; if (acedGetString(1, L"\nPile Numbering request: ", path) == RTNORM) Run(path); }
}
extern "C" __declspec(dllexport) AcRx::AppRetCode acrxEntryPoint(AcRx::AppMsgCode message, void* id) {
    if (message == AcRx::kInitAppMsg) {
        acrxDynamicLinker->unlockApplication(id); acrxDynamicLinker->registerAppMDIAware(id);
        const auto name = CommandName(); commandGroup = L"PILE_NUMBERING_SDK_" + name;
        acedRegCmds->addCommand(commandGroup.c_str(), name.c_str(), name.c_str(), ACRX_CMD_MODAL | ACRX_CMD_USEPICKSET | ACRX_CMD_REDRAW, Command);
    } else if (message == AcRx::kUnloadAppMsg) acedRegCmds->removeGroup(commandGroup.c_str());
    return AcRx::kRetOK;
}
