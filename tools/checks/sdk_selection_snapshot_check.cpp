#include "SelectionSnapshot.h"
#include <iostream>
#include <sstream>

int main() {
    std::istringstream valid("PILESDK_SELECTION_1\r\n2\r\nA\r\n2b\r\n");
    if (ReadSelectionSnapshot(valid) != std::vector<std::string>{"A", "2b"}) return 1;
    std::istringstream empty("PILESDK_SELECTION_1\n0\n");
    if (!ReadSelectionSnapshot(empty).empty()) return 2;
    for (const auto* corrupt : {
        "", "OTHER\n0\n", "PILESDK_SELECTION_1\n-1\n", "PILESDK_SELECTION_1\n1000001\n",
        "PILESDK_SELECTION_1\n1\n", "PILESDK_SELECTION_1\n1\nG\n",
        "PILESDK_SELECTION_1\n1\n12345678901234567\n", "PILESDK_SELECTION_1\n0\nA\n"
    }) {
        try {
            std::istringstream input(corrupt);
            ReadSelectionSnapshot(input);
            std::cerr << "Invalid selection snapshot was accepted\n";
            return 3;
        } catch (const std::exception&) {}
    }
    std::cout << "PASS: native selection snapshot reader, valid/empty sets and 8 corrupted snapshots.\n";
}
