#pragma once
#include <istream>
#include <stdexcept>
#include <string>
#include <vector>

// The pre-command Lisp snapshot contains handles only; entity data stays in NRX.
inline std::vector<std::string> ReadSelectionSnapshot(std::istream& input) {
    auto line = [&]() {
        std::string value;
        if (!std::getline(input, value)) throw std::runtime_error("Incomplete pre-command selection snapshot");
        if (!value.empty() && value.back() == '\r') value.pop_back();
        return value;
    };
    if (line() != "PILESDK_SELECTION_1") throw std::runtime_error("Invalid selection snapshot version");
    const auto text = line();
    if (text.empty() || text.size() > 7 || text.find_first_not_of("0123456789") != std::string::npos)
        throw std::runtime_error("Invalid selection snapshot count");
    const auto count = std::stoul(text);
    if (count > 1000000) throw std::runtime_error("Selection snapshot exceeds size limit");
    std::vector<std::string> handles;
    handles.reserve(count);
    for (size_t i = 0; i < count; ++i) {
        auto handle = line();
        if (handle.empty() || handle.size() > 16 || handle.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos)
            throw std::runtime_error("Invalid selection snapshot handle");
        handles.push_back(handle);
    }
    std::string extra;
    if (std::getline(input, extra)) throw std::runtime_error("Unexpected selection snapshot data");
    return handles;
}
